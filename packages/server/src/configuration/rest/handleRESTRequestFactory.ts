import { match } from "path-to-regexp";

import type { BunRequest } from "bun";
import type { MatchFunction } from "path-to-regexp";
import type { GetGQLEntitiesReturn } from "../../configuration/getSchemas";
import type { RemoteRESTResolved, RemoteRESTRoute } from "../../remoteREST/types";
import type { Auth } from "../../types/configuration";
import type { SessionContext } from "../../utils/sessionVariables";
import type { MergedEntities } from "../getSchemas/mergeEntities";
import type { HandleGraphQLRequest } from "../gql/handleGraphQLRequestFactory";

import { analyzeQuery } from "../../analyzeQuery";
import { checkUserCredentials } from "../../databases";
import { proxyRemoteRESTRequest } from "../../remoteREST/proxy";
import { getTokenService } from "../../singletons/authentication";
import { getCache } from "../../singletons/cache";
import { databasesConnections, repositoryMap } from "../../singletons/databases";
import { queueManager } from "../../singletons/queues";
import { S200, S401, S404 } from "../../utils/responses";
import { buildApiRoutes } from "../rest";
import { logger } from "../../logging";

// Build remote REST route matchers
type RemoteRouteEntry = {
  route: RemoteRESTRoute;
  resolved: RemoteRESTResolved;
  testPath: MatchFunction<Record<string, string>>;
};

export const handleRESTRequestFactory = (
  entities: MergedEntities,
  gqlEntities: GetGQLEntitiesReturn,
  gql: HandleGraphQLRequest,
  auth: Auth | null = null,
  gqlSuperadminHandler: HandleGraphQLRequest | null = null,
) => {
  const { operationsEnhanced } = buildApiRoutes(
    entities,
    gqlEntities,
    gql,
    auth,
    gqlSuperadminHandler,
  );

  const routes = Object.values(operationsEnhanced);

  const remoteRoutes: RemoteRouteEntry[] = [];
  for (const rr of entities.remoteRESTApis) {
    for (const route of rr.routes) {
      // Convert OpenAPI path params {id} to path-to-regexp :id
      const expressPath = route.prefixedPath.replace(/\{([^}]+)\}/g, ":$1");
      remoteRoutes.push({
        route,
        resolved: rr,
        testPath: match<Record<string, string>>(expressPath),
      });
    }
  }

  const routesInitDataPromises: Record<string, unknown> = {};

  return {
    operationsEnhanced,
    handler: async (
      url: URL,
      pathname: string,
      method = "GET",
      req: BunRequest,
      session?: SessionContext,
    ) => {
      const log = logger("rest").child({ role: session?.role });
      log.debug({ method, pathname }, "rest request");

      let pathParameters: Record<string, string | string[]> = {};

      const route = routes.find((a) => {
        const pathFound = a.testPath(pathname);

        if (pathFound && a.rest!.method === method) {
          pathParameters = pathFound.params as Record<string, string>;

          return true;
        }

        return false;
      });

      if (!route) {
        // Try remote REST routes
        for (const remote of remoteRoutes) {
          const pathFound = remote.testPath(pathname);
          if (pathFound && remote.route.method === method.toLowerCase()) {
            return proxyRemoteRESTRequest(
              remote.route,
              remote.resolved,
              req,
              (pathFound.params ?? {}) as Record<string, string>,
              url.search ? url.search.slice(1) : "",
            );
          }
        }

        return new S404({ error: "Method not found" });
      }

      if (route.hasError) return new S401({ error: "You are not authorized" });

      if (routesInitDataPromises[route.routeKey] === undefined) {
        routesInitDataPromises[route.routeKey] = await route.hooks?.init?.({
          gqlQuery: gqlSuperadminHandler?.handler ?? gql.handler,
          databases: databasesConnections,
          queues: queueManager,
          repository: repositoryMap,
        });
      }

      // Validate and parse path parameters with Zod
      const pathVariables = route.rest!.pathParams?.parse(pathParameters) as Record<
        string,
        unknown
      >;

      const paramsQuery = new URLSearchParams(url.search);
      const paramsQueryDictionary = Object.fromEntries(paramsQuery.entries());

      const queryVariables = (route.rest!.queryParams?.parse(paramsQueryDictionary) ??
        {}) as Record<string, unknown>;

      let bodyVariables: Record<string, unknown> = {};

      if (req.method === "POST") {
        const body = req.body ? await req.json() : {};

        bodyVariables = (route.rest!.body?.parse(body) ?? {}) as Record<string, unknown>;
      }

      // Prepare all variables for the request
      const allVariables = {
        ...pathVariables,
        ...queryVariables,
        ...bodyVariables,
      };

      // Only analyze query if route has a query (not a custom handler)
      const queryAnalysis = route.query
        ? analyzeQuery(route.query, entities, gqlEntities.schema)
        : null;

      const variables =
        (await route.hooks?.beforeRequest?.(
          {
            input: allVariables,
          },
          routesInitDataPromises[route.routeKey],
        )) ?? allVariables;

      // Handle auth routes directly without going through GQL pipeline
      if (route.authOperation) {
        if (!auth?.enabled) {
          return new S401({ errors: ["Authentication is not enabled"] });
        }

        try {
          if (route.authOperation === "login") {
            const { username, password } = variables as {
              username: string;
              password: string;
            };

            const result = await checkUserCredentials(auth, username, password);

            if (!result.valid) {
              return new S401({ errors: ["Invalid username or password"] });
            }

            const data = await getTokenService().createTokenPair({
              sub: username,
              role: result.role,
              claims: result.claims,
            });

            if (req?.cookies) {
              req.cookies.set("refresh_token", data.refresh_token, {
                httpOnly: true,
                secure: true,
                sameSite: "strict",
              });
            }

            return new S200({
              data: {
                access_token: data.access_token,
                expires_in: data.expires_in,
                role: result.role,
              },
            });
          }

          if (route.authOperation === "refresh") {
            const tokenValue = req?.cookies?.get("refresh_token");

            if (!tokenValue) {
              return new S401({ errors: ["Refresh token is required"] });
            }

            const result = await getTokenService().refreshAccessToken(tokenValue.toString());

            if (req?.cookies) {
              req.cookies.set("refresh_token", result.refresh_token, {
                httpOnly: true,
                secure: true,
                sameSite: "strict",
              });
            }

            return new S200({
              data: {
                access_token: result.access_token,
                expires_in: result.expires_in,
                role: result.role,
              },
            });
          }

          if (route.authOperation === "logout") {
            const tokenService = getTokenService();

            if (session?.jti) {
              await tokenService.revoke(session.jti);
            }

            const refreshCookie = req?.cookies?.get("refresh_token");
            if (refreshCookie) {
              try {
                const refreshPayload = await tokenService.verifyToken(refreshCookie.toString(), {
                  audience: "refresh",
                });
                await tokenService.revoke(refreshPayload.jti);
              } catch {
                // tampered or expired cookie — nothing to revoke
              }
            }

            if (req?.cookies) {
              req.cookies.delete("refresh_token");
            }

            return new S200({ data: true });
          }

          if (route.authOperation === "me") {
            return new S200({
              data: session?.sub ? { username: session.sub, role: session.role } : null,
            });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return new S401({ errors: [message] });
        }
      }

      // Check if this route uses a custom handler
      if (route.handler) {
        try {
          const result = await route.handler(
            {
              gqlQuery: gqlSuperadminHandler?.handler ?? gql.handler,
              databases: databasesConnections,
              queues: queueManager,
              repository: repositoryMap,
            },
            variables,
          );

          // Apply afterRequest hook if present
          const finalResult = route.hooks?.afterRequest
            ? await route.hooks.afterRequest({
                output: result,
              })
            : result;

          return new S200(finalResult);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return new S401({ errors: [message] });
        }
      }

      // Check if this route has caching enabled
      const cache = route.routeKey ? getCache(route.routeKey) : undefined;

      if (cache && route.query) {
        // Create cache key from route pattern, method, variables, and session
        const cacheKey = JSON.stringify({
          pathname,
          method,
          variables,
          sub: session?.sub,
          role: session?.role,
        });

        // Try to get from cache first
        const cachedResult = await cache.get(cacheKey);
        if (cachedResult) {
          log.debug({ route: route.routeKey }, "rest cache hit");
          return new S200(cachedResult);
        }
        log.debug({ route: route.routeKey }, "rest cache miss");

        try {
          // Execute the GraphQL request
          const result = await gql.handler(queryAnalysis!, variables, req, session);

          // Cache the result
          await cache.set(cacheKey, result);

          return new S200(result);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return new S401({ errors: [message] });
        }
      } else if (queryAnalysis) {
        // No caching for this route, execute normally
        return new S200(await gql.handler(queryAnalysis, variables, req, session));
      }

      // Fallback - should not reach here if endpoint is properly configured
      return new S401({
        errors: ["Endpoint misconfigured: no query or customHandler"],
      });
    },
  };
};

export type HandleRESTRequest = ReturnType<typeof handleRESTRequestFactory>;

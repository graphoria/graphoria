import { match } from "path-to-regexp";

import type { BunRequest } from "bun";
import type { MatchFunction } from "path-to-regexp";
import type { SchemaEntities } from "../../configuration/getSchemas";
import type { RemoteRESTResolved, RemoteRESTRoute } from "../../remoteREST/types";
import type { Auth } from "../../types/configuration";
import type { SessionContext } from "../../utils/sessionVariables";
import type { HandleGraphQLRequest } from "../gql/handleGraphQLRequestFactory";

import { checkUserCredentials } from "../../databases";
import { proxyRemoteRESTRequest } from "../../remoteREST/proxy";
import { actorFromSession, audit } from "../../logging/audit";
import { getTokenService } from "../../singletons/authentication";
import { getCache } from "../../singletons/cache";
import type { CacheStore } from "../../singletons/cache";
import { databasesConnections, repositoryMap } from "../../singletons/databases";
import { queueManager } from "../../singletons/queues";
import { S200, S200Serialized, S304, S401, S404 } from "../../utils/responses";
import { buildApiRoutes } from "../rest";
import { parseStringParams } from "./parseStringParams";
import { logger } from "../../logging";

// Build remote REST route matchers
type RemoteRouteEntry = {
  route: RemoteRESTRoute;
  resolved: RemoteRESTResolved;
  testPath: MatchFunction<Record<string, string>>;
};

// The ETag of a serialized body, derived from the exact stored text.
const etagFor = (text: string): string => `"${Bun.hash(text).toString(36)}"`;
export const handleRESTRequestFactory = (
  entities: SchemaEntities,
  gql: HandleGraphQLRequest,
  auth: Auth | null = null,
  gqlSuperadminHandler: HandleGraphQLRequest | null = null,
) => {
  const { operationsEnhanced } = buildApiRoutes(entities, gql, auth, gqlSuperadminHandler);

  const routes = Object.values(operationsEnhanced);

  // Static paths answer with one map lookup; paths with params or regex syntax
  // keep the path-to-regexp scan. The charset stays conservative so a path
  // path-to-regexp would treat specially never reaches the map.
  const staticRoutes = new Map<string, (typeof routes)[number]>();
  // The cache key of a static route's anonymous parameterless request never
  // changes, so build it once instead of per request.
  const staticCacheKeys = new Map<(typeof routes)[number], string>();
  const dynamicRoutes: (typeof routes)[number][] = [];
  for (const route of routes) {
    const path = route.rest!.path;
    if (/^[/a-zA-Z0-9_-]+$/.test(path)) {
      const key = `${route.rest!.method}:${path}`;
      if (!staticRoutes.has(key)) {
        staticRoutes.set(key, route);
        staticCacheKeys.set(
          route,
          JSON.stringify({ pathname: path, method: route.rest!.method, variables: {} }),
        );
      }
    } else {
      dynamicRoutes.push(route);
    }
  }

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

  const inflight = new Map<string, Promise<string>>();

  // Per-role pino children: roles are bounded, so the logger stops being a
  // per-request allocation after each role's first request.
  const roleLoggers = new Map<string, ReturnType<typeof logger>>();
  const logFor = (role: string | undefined) => {
    const key = role ?? "";
    const existing = roleLoggers.get(key);
    if (existing) return existing;
    const created = logger("rest").child({ role });
    roleLoggers.set(key, created);
    return created;
  };

  // Lazy so a store re-registered after factory creation (tests) is picked up.
  const cacheByRouteKey = new Map<string, CacheStore | undefined>();
  const cacheFor = (routeKey: string | undefined): CacheStore | undefined => {
    if (!routeKey) return undefined;
    if (!cacheByRouteKey.has(routeKey)) cacheByRouteKey.set(routeKey, getCache(routeKey));
    return cacheByRouteKey.get(routeKey);
  };

  return {
    operationsEnhanced,
    handler: async (
      url: URL,
      pathname: string,
      method = "GET",
      req: BunRequest,
      session?: SessionContext,
    ) => {
      const log = logFor(session?.role);
      log.debug({ method, pathname }, "rest request");

      let pathParameters: Record<string, string | string[]> = {};

      const staticRoute = staticRoutes.get(`${method}:${pathname}`);
      const route =
        staticRoute ??
        dynamicRoutes.find((a) => {
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
          gqlQuery: gqlSuperadminHandler?.operatorQuery ?? gql.operatorQuery,
          databases: databasesConnections,
          queues: queueManager,
          repository: repositoryMap,
        });
      }

      // Validate and parse each REST parameter source with Zod. A source is
      // left `undefined` when its schema is not configured; that `undefined` is
      // forwarded to `beforeRequest` so the hook can tell the sources apart,
      // while `allVariables` stays identical because spreading `undefined` is a
      // no-op. Path and query values are strings on the wire, so
      // `parseStringParams` converts the keys declared as `z.boolean()` first.
      const pathVariables = parseStringParams(route.rest!.pathParams, pathParameters);

      const queryVariables = route.rest!.queryParams
        ? parseStringParams(
            route.rest!.queryParams,
            Object.fromEntries(new URLSearchParams(url.search).entries()),
          )
        : undefined;

      let bodyVariables: Record<string, unknown> | undefined;

      if (req.method === "POST") {
        const body = req.body ? await req.json() : {};

        bodyVariables = route.rest!.body?.parse(body) as Record<string, unknown> | undefined;
      }

      // Prepare all variables for the request
      const allVariables = {
        ...pathVariables,
        ...queryVariables,
        ...bodyVariables,
      };

      const queryAnalysis = route.queryStructure;

      const variables =
        (await route.hooks?.beforeRequest?.(
          {
            input: allVariables,
            pathParams: pathVariables,
            queryParams: queryVariables,
            body: bodyVariables,
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

            const actor = { type: "credentials", sub: username } as const;
            if (!result.valid) {
              audit().emit({
                action: "auth.login",
                outcome: "failure",
                actor,
                target: { kind: "auth", via: "rest" },
                reason: "Invalid username or password",
              });
              return new S401({ errors: ["Invalid username or password"] });
            }
            audit().emit({
              action: "auth.login",
              outcome: "success",
              actor,
              target: { kind: "auth", via: "rest", role: result.role },
            });

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
            const revoked: string[] = [];

            if (session?.jti) {
              await tokenService.revoke(session.jti);
              revoked.push(session.jti);
            }

            const refreshCookie = req?.cookies?.get("refresh_token");
            if (refreshCookie) {
              try {
                const refreshPayload = await tokenService.verifyToken(refreshCookie.toString(), {
                  audience: "refresh",
                });
                await tokenService.revoke(refreshPayload.jti);
                revoked.push(refreshPayload.jti);
              } catch {
                // tampered or expired cookie — nothing to revoke
              }
            }

            if (req?.cookies) {
              req.cookies.delete("refresh_token");
            }

            if (revoked.length > 0) {
              audit().emit({
                action: "auth.logout",
                actor: actorFromSession(session),
                target: { kind: "auth", via: "rest", revoked },
              });
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
              gqlQuery: gqlSuperadminHandler?.operatorQuery ?? gql.operatorQuery,
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

      // Apply the operation's afterRequest hook (if configured) to a GraphQL
      // result. The hook receives the unwrapped `data` payload; its return
      // replaces `data`, leaving the rest of the envelope (e.g. `sqlQueries`)
      // intact.
      const applyAfterRequest = async (result: Awaited<ReturnType<typeof gql.handler>>) => {
        if (!route.hooks?.afterRequest) return result;

        return {
          ...result,
          data: await route.hooks.afterRequest({ output: result.data }),
        };
      };

      // Check if this route has caching enabled
      const cache = cacheFor(route.routeKey);

      if (cache && route.query) {
        // Create cache key from route pattern, method, variables, and session.
        // The concatenated form is byte-identical to stringifying the whole
        // object: each component is JSON-encoded separately, undefined props
        // are omitted, and the field order matches.
        const precomputedKey = staticCacheKeys.get(route);
        const cacheKey =
          precomputedKey !== undefined && Object.keys(variables).length === 0 && !session
            ? precomputedKey
            : (() => {
                let key = `{"pathname":${JSON.stringify(pathname)},"method":${JSON.stringify(
                  method,
                )},"variables":${JSON.stringify(variables)}`;
                if (session?.sub !== undefined) key += `,"sub":${JSON.stringify(session.sub)}`;
                if (session?.role !== undefined)
                  key += `,"role":${JSON.stringify(session.role)}`;
                return key + "}";
              })();

        // Try to get from cache first. A cached entry has already been through
        // afterRequest, so serve it directly without re-running the hook.
        const cachedResult = await cache.get(cacheKey);
        if (cachedResult !== undefined) {
          log.debug({ route: route.routeKey }, "rest cache hit");
          const etag = etagFor(cachedResult);
          if (req.headers?.get("if-none-match") === etag) return new S304();
          return new S200Serialized(cachedResult, etag);
        }
        log.debug({ route: route.routeKey }, "rest cache miss");

        const pending = inflight.get(cacheKey);
        if (pending !== undefined) {
          try {
            return new S200Serialized(await pending);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return new S401({ errors: [message] });
          }
        }

        const promise = (async () => {
          // Execute the GraphQL request, then transform via afterRequest before
          // caching so hits and misses return the same shape.
          const result = await applyAfterRequest(
            await gql.operatorQuery(queryAnalysis!, variables, req, session, route.timeout),
          );

          const serialized = JSON.stringify(result);

          // Cache the (already transformed) result
          await cache.set(cacheKey, serialized);

          return serialized;
        })();
        inflight.set(cacheKey, promise);
        try {
          const serialized = await promise;
          return new S200Serialized(serialized, etagFor(serialized));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return new S401({ errors: [message] });
        } finally {
          inflight.delete(cacheKey);
        }
      } else if (queryAnalysis) {
        // No caching for this route, execute normally
        return new S200(
          await applyAfterRequest(
            await gql.operatorQuery(queryAnalysis, variables, req, session, route.timeout),
          ),
        );
      }

      // Fallback - should not reach here if endpoint is properly configured
      return new S401({
        errors: ["Endpoint misconfigured: no query or customHandler"],
      });
    },
  };
};

export type HandleRESTRequest = ReturnType<typeof handleRESTRequestFactory>;

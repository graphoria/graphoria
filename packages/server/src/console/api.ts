import { BREAK, parse, TypeInfo, visit, visitWithTypeInfo } from "graphql";

import type { DocumentNode, GraphQLSchema } from "graphql";
import type { ConsoleScope } from "./session";
import type { TokenService } from "../authentication/types";
import type { AnalyzedConfiguration } from "../configuration";
import type { Configuration } from "../types/configuration";
import type { Env } from "../types/env";
import type { RateLimiter } from "../utils/rateLimit";
import type { BunRequest } from "bun";
import type { AuthUserSummary } from "../databases/core/function-mapping";
import type { DatabasesConnections } from "../singletons/databases";

import { renderAnswerHtml } from "./markdown";
import { createConsoleSessions } from "./session";
import { getTags } from "../configuration/rest/generateOpenAPI";
import { audit } from "../logging/audit";
import { askAgent, resolveAISurfaces } from "../singletons/ai";
import { getCronJobs } from "../singletons/cron";
import { databasesConnections, pingConnection } from "../singletons/databases";
import {
  AuthUserProtectedError,
  deleteAuthUser,
  getAuthUser,
  insertAuthUser,
  listAuthUsers,
  parseAuthUserActiveInput,
  parseAuthUserInput,
  parseAuthUserPasswordInput,
  parseAuthUserUpdateInput,
  parseAuthUsername,
  resetAuthUserPassword,
  setAuthUserActive,
  updateAuthUser,
  userRoles,
} from "../databases";
import { AUTH_USERNAME_MAX_LENGTH } from "../databases/auth/users";
import { queueManager } from "../singletons/queues";
import { resolveClientAddress } from "../utils/rateLimit";
import { S200, S400, S401, S403, S404, S409, S429 } from "../utils/responses";

type ConsoleRoutesFactoryOptions = {
  env: Env;
  consolePath: string;
  prefixes: Record<string, string>;
  projectConfiguration: Configuration;
  analyzedConfiguration: AnalyzedConfiguration;
  tokenService: TokenService;
  rateLimiter?: RateLimiter | undefined;
};

// Bun hands a route handler the server as its second argument; the parameter is
// optional only because the type is also used for handlers that ignore it.
type ConsoleRouteHandler = (
  req: BunRequest,
  server?: Bun.Server<unknown>,
) => Response | Promise<Response>;

const PING_TIMEOUT_MS = 2000;
const USERS_PAGE_SIZE = 50;

const measureLatency = async (connection: DatabasesConnections[string], type: string) => {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pingConnection(connection, type),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), PING_TIMEOUT_MS);
      }),
    ]);
    return Math.round(performance.now() - start);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const selectsAsk = (schema: GraphQLSchema, document: DocumentNode) => {
  const queryType = schema.getQueryType();
  const typeInfo = new TypeInfo(schema);
  let found = false;

  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        if (node.name.value !== "ask" || typeInfo.getParentType() !== queryType) return;
        found = true;
        return BREAK;
      },
    }),
  );

  return found;
};

export const consoleRoutesFactory = ({
  env,
  consolePath,
  prefixes,
  projectConfiguration,
  analyzedConfiguration,
  tokenService,
  rateLimiter,
}: ConsoleRoutesFactoryOptions): Record<string, Record<string, ConsoleRouteHandler>> => {
  const sessions = createConsoleSessions({ env, consolePath, tokenService });
  const aiSurfaces = resolveAISurfaces(env, projectConfiguration.ai);

  const auth = projectConfiguration.auth;
  // The superadmin role bypasses RBAC, so a console session may not mint a user
  // who holds it: only `graphoria seed-auth` assigns it.
  const consoleUserRoles = () =>
    userRoles(auth, env).filter((role) => role !== env.superadmin.role);

  const clientAddress = (req: BunRequest, server?: Bun.Server<unknown>) =>
    resolveClientAddress(req, server, env.rateLimit.trustProxy);

  const configuredAiRole = (requested: unknown) => {
    const role = requested ?? env.superadmin.role;
    if (typeof role !== "string" || !Object.hasOwn(analyzedConfiguration.roles, role))
      throw new Error(`Unknown role "${role}"`);
    const roleEntities = analyzedConfiguration.roles[role];
    if (!roleEntities.entityOfRole.ai)
      throw new Error(`Role "${role}" is not granted the AI agent`);
    return { role, roleEntities };
  };

  const guarded =
    (
      handler: (
        req: BunRequest,
        server: Bun.Server<unknown> | undefined,
        scope: ConsoleScope,
      ) => object | Promise<object>,
      required: ConsoleScope = "read",
    ): ConsoleRouteHandler =>
    async (req: BunRequest, server?: Bun.Server<unknown>) => {
      try {
        const scope = await sessions.authorize(req);
        if (!scope) return new S404({ error: "Not Found" });
        if (required === "write" && scope !== "write")
          return new S403({ errors: [{ message: "Console session is read-only" }] });
        const result = await handler(req, server, scope);
        return result instanceof Response ? result : new S200(result);
      } catch (error) {
        if (error instanceof AuthUserProtectedError)
          return new S403({ errors: [{ message: error.message }] });
        return new S400({ errors: [{ message: (error as Error)?.message }] });
      }
    };

  // A missing user answers 400, never 404: the console client reads any 404 as
  // an expired session and logs the operator out.
  const managedUser = async (username: string): Promise<AuthUserSummary> => {
    const user = await getAuthUser(auth, username);
    if (!user) throw new Error(`User "${username}" does not exist`);
    if (user.role === env.superadmin.role) throw new AuthUserProtectedError(username);
    return user;
  };

  const cors: Record<string, ConsoleRouteHandler> = env.enableCors
    ? { OPTIONS: () => new S200(null) }
    : {};
  const base = `${consolePath}/api`;

  return {
    [`${base}/meta`]: {
      ...cors,
      GET: () =>
        new S200({
          name: projectConfiguration.name,
          version: projectConfiguration.version,
        }),
    },

    [`${base}/login`]: {
      ...cors,
      POST: async (req, server) => {
        // Keyed by address against the anonymous ceiling: there is no session
        // yet, and the attempt is charged before the secret is compared, so a
        // guesser cannot spend attempts for free.
        const ip = clientAddress(req, server);
        const limit = await rateLimiter?.check(null, ip);
        if (limit && !limit.allowed) return new S429(limit.retryAfterMs);

        const actor = { type: "admin_secret", ip } as const;
        try {
          const { expiresIn, scope, superset } = await sessions.login(req);
          audit().emit({
            action: "console.login",
            outcome: "success",
            actor: { ...actor, scope: superset ? "all" : `console:${scope}` },
            target: { kind: "console" },
          });
          return new S200({ expiresIn, scope });
        } catch (error) {
          audit().emit({
            action: "console.login",
            outcome: "failure",
            actor,
            target: { kind: "console" },
            reason: (error as Error)?.message,
          });
          // One message for a bad secret and for a malformed body alike: the
          // caller learns nothing about which it was.
          return new S401({ errors: [{ message: "Invalid admin secret" }] });
        }
      },
    },

    [`${base}/logout`]: {
      ...cors,
      POST: async (req, server) => {
        if (await sessions.logout(req)) {
          audit().emit({
            action: "console.logout",
            actor: { type: "console", ip: clientAddress(req, server) },
            target: { kind: "console" },
          });
        }
        return new S200({ ok: true });
      },
    },

    [`${base}/tables`]: {
      ...cors,
      GET: guarded(() => ({
        tables: analyzedConfiguration.roles[env.superadmin.role].tables.map((table) => ({
          schema: table.schema,
          name: table.name,
          entityType: table.entityType,
          resolverName: table.resolverName,
          description: table.tableDescription,
          columns: table.columns.map((column) => ({
            name: column.name,
            dataType: column.dataType,
            isNullable: column.isNullable,
            description: column.description,
          })),
          relationships: table.relationships.map((relationship) => ({
            schema: relationship.schema,
            name: relationship.name,
            columns: relationship.columns.map((column: { source: string; target: string }) => ({
              source: column.source,
              target: column.target,
            })),
          })),
        })),
      })),
    },

    [`${base}/roles`]: {
      ...cors,
      GET: guarded(() => ({
        roles: Object.keys(analyzedConfiguration.roles),
        permissions: analyzedConfiguration.auth?.permissions ?? {},
      })),
    },

    [`${base}/roles/entities`]: {
      ...cors,
      GET: guarded((req) => {
        const role = new URL(req.url).searchParams.get("role") ?? "";
        const roleEntities = analyzedConfiguration.roles[role];
        if (!roleEntities) throw new Error(`Unknown role "${role}"`);
        return {
          role,
          tables: roleEntities.tables.map((table) => ({
            schema: table.schema,
            name: table.name,
            columns: table.columns.map((column) => column.name),
          })),
          operations: Object.entries(roleEntities.operations ?? {}).map(([name, operation]) => ({
            name,
            method: operation.rest?.method ?? null,
            path: operation.rest?.path ?? null,
          })),
          remoteSchemas: (roleEntities.remoteSchemas ?? []).map((schema) => ({
            name: schema.config.name,
            prefix: schema.prefix,
            queryFields: schema.queryFields.length,
            mutationFields: schema.mutationFields.length,
          })),
          remoteREST: (roleEntities.remoteRESTApis ?? []).map((api) => ({
            name: api.config.name,
            prefix: api.prefix,
            routes: api.routes.length,
          })),
        };
      }),
    },

    [`${base}/status`]: {
      ...cors,
      GET: guarded(async () => ({
        uptimeSeconds: process.uptime(),
        tokenStrategy: env.authStrategy ?? projectConfiguration.tokenStrategy,
        memoryRssBytes: process.memoryUsage().rss,
        bunVersion: Bun.version,
        pid: process.pid,
        databases: await Promise.all(
          analyzedConfiguration.databases.map(async (database) => {
            const connection = databasesConnections[database.name];
            return {
              name: database.name,
              type: database.type,
              connected: connection !== undefined,
              latencyMs: connection ? await measureLatency(connection, database.type) : null,
            };
          }),
        ),
        publishers: Object.keys(queueManager?.publisherMap() ?? {}),
        subscribers: (analyzedConfiguration.queues ?? []).flatMap((queue) =>
          queue.queues.map((subscriber) => ({
            name: subscriber.name,
            topic: subscriber.bindings[0]?.exchange ?? "",
          })),
        ),
        queueConnections: queueManager?.connections() ?? [],
        cron: getCronJobs()?.getSummary() ?? [],
      })),
    },

    [`${base}/apis`]: {
      ...cors,
      GET: guarded(() => {
        const superadmin = analyzedConfiguration.roles[env.superadmin.role];
        return {
          operations: Object.entries(superadmin.operations ?? {})
            .filter(([, operation]) => operation.rest)
            .map(([name, operation]) => ({
              name,
              method: operation.rest!.method,
              path: operation.rest!.path,
              tag: getTags(operation.rest!.path)[0],
            })),
          remoteREST: (superadmin.remoteRESTApis ?? []).map((api) => ({
            name: api.config.name,
            prefix: api.prefix,
            baseUrl: api.baseUrl,
            routes: api.routes.length,
          })),
          remoteSchemas: (superadmin.remoteSchemas ?? []).map((schema) => ({
            name: schema.config.name,
            prefix: schema.prefix,
            url: schema.config.url,
            queryFields: schema.queryFields.length,
            mutationFields: schema.mutationFields.length,
          })),
        };
      }),
    },

    [`${base}/schema`]: {
      ...cors,
      GET: guarded((req) => {
        const role = new URL(req.url).searchParams.get("role") ?? "";
        const roleSchema = analyzedConfiguration.roles[role];
        if (!roleSchema) throw new Error(`Unknown role "${role}"`);
        return { role, sdl: roleSchema.typeDefs };
      }),
    },

    [`${base}/config`]: {
      ...cors,
      GET: guarded((_req, _server, scope) => ({
        name: projectConfiguration.name,
        version: projectConfiguration.version,
        prefixes,
        features: {
          auth: projectConfiguration.auth?.enabled ?? false,
          ai: aiSurfaces.agent,
          mcp: aiSurfaces.mcp,
          cors: env.enableCors,
        },
        session: { scope },
      })),
    },

    [`${base}/queues/publish`]: {
      ...cors,
      POST: guarded(async (req, server) => {
        const { publisher, message, key } = (await req.json()) as {
          publisher?: string;
          message?: string | object;
          key?: string;
        };
        if (!publisher || message == null) throw new Error("publisher and message are required");
        if (!Object.hasOwn(queueManager?.publisherMap() ?? {}, publisher))
          throw new Error(`Unknown publisher "${publisher}"`);
        audit().emit({
          action: "console.queue.publish",
          actor: { type: "console", ip: clientAddress(req, server) },
          target: { kind: "publisher", name: publisher, key },
        });
        return { ok: await queueManager!.sendMessage(publisher, message, key) };
      }, "write"),
    },

    [`${base}/cron`]: {
      ...cors,
      POST: guarded(async (req, server) => {
        const { name, action } = (await req.json()) as { name?: string; action?: string };
        const cron = getCronJobs();
        if (!cron) throw new Error("Cron is not enabled");
        if (!name) throw new Error("name is required");
        if (action !== "trigger" && action !== "pause" && action !== "resume")
          throw new Error(`Unknown action "${action}"`);
        if (!cron.getJob(name)) throw new Error(`Unknown job "${name}"`);
        audit().emit({
          action: `console.cron.${action}`,
          actor: { type: "console", ip: clientAddress(req, server) },
          target: { kind: "cron", name },
        });
        if (action === "trigger") await cron.trigger(name);
        else cron[action](name);
        return { ok: true };
      }, "write"),
    },

    ...(auth.enabled
      ? {
          [`${base}/users/roles`]: {
            ...cors,
            GET: guarded(() => ({ roles: consoleUserRoles() }), "write"),
          },
          [`${base}/users`]: {
            ...cors,
            // Any console session: only creating a user needs a write session.
            GET: guarded(async (req) => {
              const params = new URL(req.url).searchParams;
              const search = params.get("search") ?? "";
              const page = Number(params.get("page") ?? 1);
              // No username is longer, so a longer search could match nothing.
              if (search.length > AUTH_USERNAME_MAX_LENGTH)
                throw new Error(`search must be at most ${AUTH_USERNAME_MAX_LENGTH} characters`);
              if (!Number.isSafeInteger(page) || page < 1)
                throw new Error("page must be a positive integer");

              const { users, total } = await listAuthUsers(auth, {
                search,
                role: params.get("role") ?? "",
                offset: (page - 1) * USERS_PAGE_SIZE,
                limit: USERS_PAGE_SIZE,
              });
              return { users, total, pageSize: USERS_PAGE_SIZE, roles: userRoles(auth, env) };
            }),
            POST: guarded(async (req, server) => {
              const input = parseAuthUserInput(await req.json());
              if (input.role === env.superadmin.role)
                throw new Error(
                  `Role "${input.role}" is assigned with graphoria seed-auth, not from the console`,
                );
              const roles = consoleUserRoles();
              if (!roles.includes(input.role))
                throw new Error(
                  `Role "${input.role}" is not a role a user can hold (${roles.join(", ") || "none"})`,
                );

              const actor = { type: "console", ip: clientAddress(req, server) } as const;
              const target = { kind: "user", name: input.username, role: input.role };
              try {
                await insertAuthUser(auth, input);
              } catch (error) {
                audit().emit({
                  action: "console.user.create",
                  outcome: "failure",
                  actor,
                  target,
                  reason: (error as Error)?.message,
                });
                if ((error as Error)?.name === "AuthUserExistsError")
                  return new S409({ errors: [{ message: (error as Error).message }] });
                throw error;
              }
              audit().emit({ action: "console.user.create", outcome: "success", actor, target });
              return { ok: true };
            }, "write"),
            PATCH: guarded(async (req, server) => {
              const input = parseAuthUserUpdateInput(await req.json());
              const roles = consoleUserRoles();
              if (!roles.includes(input.role))
                throw new Error(
                  `Role "${input.role}" is not a role a user can hold (${roles.join(", ") || "none"})`,
                );

              const previous = await managedUser(input.username);
              const actor = { type: "console", ip: clientAddress(req, server) } as const;
              const target = {
                kind: "user",
                name: input.username,
                role: input.role,
                previousRole: previous.role,
              } as const;
              try {
                // A new role or new claims invalidate every refresh token the
                // user holds, so they must re-authenticate under the new grant.
                await tokenService.revokeUserRefreshTokens(input.username);
                await updateAuthUser(auth, input);
              } catch (error) {
                audit().emit({
                  action: "console.user.update",
                  outcome: "failure",
                  actor,
                  target,
                  reason: (error as Error)?.message,
                });
                throw error;
              }
              audit().emit({ action: "console.user.update", outcome: "success", actor, target });
              return { ok: true };
            }, "write"),
            DELETE: guarded(async (req, server) => {
              const username = parseAuthUsername(new URL(req.url).searchParams.get("username"));
              const user = await managedUser(username);
              const actor = { type: "console", ip: clientAddress(req, server) } as const;
              const target = { kind: "user", name: username, role: user.role } as const;
              // A deleted user must not keep minting access tokens from the
              // refresh tokens they already hold.
              try {
                await tokenService.revokeUserRefreshTokens(username);
                await deleteAuthUser(auth, username);
              } catch (error) {
                audit().emit({
                  action: "console.user.delete",
                  outcome: "failure",
                  actor,
                  target,
                  reason: (error as Error)?.message,
                });
                throw error;
              }
              audit().emit({ action: "console.user.delete", outcome: "success", actor, target });
              return { ok: true };
            }, "write"),
          },
          [`${base}/users/active`]: {
            ...cors,
            POST: guarded(async (req, server) => {
              const input = parseAuthUserActiveInput(await req.json());
              const user = await managedUser(input.username);
              const actor = { type: "console", ip: clientAddress(req, server) } as const;
              const target = {
                kind: "user",
                name: input.username,
                role: user.role,
                active: input.isActive,
              } as const;
              // A deactivated user must not keep minting access tokens from the
              // refresh tokens they already hold.
              try {
                if (!input.isActive) await tokenService.revokeUserRefreshTokens(input.username);
                await setAuthUserActive(auth, input);
              } catch (error) {
                audit().emit({
                  action: input.isActive ? "console.user.activate" : "console.user.deactivate",
                  outcome: "failure",
                  actor,
                  target,
                  reason: (error as Error)?.message,
                });
                throw error;
              }
              audit().emit({
                action: input.isActive ? "console.user.activate" : "console.user.deactivate",
                outcome: "success",
                actor,
                target,
              });
              return { ok: true };
            }, "write"),
          },
          [`${base}/users/password`]: {
            ...cors,
            POST: guarded(async (req, server) => {
              const input = parseAuthUserPasswordInput(await req.json());
              const user = await managedUser(input.username);
              const actor = { type: "console", ip: clientAddress(req, server) } as const;
              const target = { kind: "user", name: input.username, role: user.role } as const;
              // The old password may already have bought sessions, so the
              // refresh tokens go before the write rather than after it.
              try {
                await tokenService.revokeUserRefreshTokens(input.username);
                await resetAuthUserPassword(auth, input);
              } catch (error) {
                audit().emit({
                  action: "console.user.resetPassword",
                  outcome: "failure",
                  actor,
                  target,
                  reason: (error as Error)?.message,
                });
                throw error;
              }
              audit().emit({
                action: "console.user.resetPassword",
                outcome: "success",
                actor,
                target,
              });
              return { ok: true };
            }, "write"),
          },
        }
      : {}),

    ...(aiSurfaces.agent
      ? {
          [`${base}/ai`]: {
            ...cors,
            GET: guarded(
              () => ({
                roles: Object.keys(analyzedConfiguration.roles).filter(
                  (role) => analyzedConfiguration.roles[role].entityOfRole.ai,
                ),
              }),
              "write",
            ),
            POST: guarded(async (req, server) => {
              const body = (await req.json()) as { prompt?: unknown; role?: unknown };
              const { role, roleEntities } = configuredAiRole(body.role);

              const ip = clientAddress(req, server);
              const session = { sub: "console", role };
              const limit = await rateLimiter?.check(session, ip);
              if (limit && !limit.allowed) return new S429(limit.retryAfterMs);

              // No `req`: the tools would forward its headers, the console
              // session cookie among them, to a remote source's forwardHeaders.
              const { answer, queries } = await askAgent(
                body.prompt,
                { role: roleEntities, session },
                { actor: { type: "console", ip, role }, via: "console" },
              );
              return { answer, answerHtml: renderAnswerHtml(answer), queries };
            }, "write"),
          },
          [`${base}/graphql`]: {
            ...cors,
            POST: guarded(async (req, server) => {
              const body = (await req.json()) as { query?: unknown; role?: unknown };
              const { role, roleEntities } = configuredAiRole(body.role);

              const session = { sub: "console", role };
              const limit = await rateLimiter?.check(session, clientAddress(req, server));
              if (limit && !limit.allowed) return new S429(limit.retryAfterMs);

              if (typeof body.query !== "string" || body.query.trim().length === 0)
                throw new Error("`query` (string) is required");

              const document = parse(body.query);
              if (
                document.definitions.some(
                  (definition) =>
                    definition.kind === "OperationDefinition" && definition.operation !== "query",
                )
              )
                throw new Error("Only `query` operations are allowed");

              const { hasErrors, validationErrors } = roleEntities.handlers.gql.hasErrors(
                body.query,
              );
              if (hasErrors)
                throw new Error(validationErrors.map((error) => error.message).join("\n"));

              // `ask` would run the agent here, audited as an anonymous `graphql`
              // caller rather than the console: questions go through /api/ai.
              if (selectsAsk(roleEntities.schema, document))
                throw new Error("`ask` is not allowed here: ask the agent through /api/ai");

              // No `req`: a remote source's `forwardHeaders` would receive the
              // console session cookie, and the agent ran these queries without one.
              const request = new Request("http://graphoria.local/graphql", {
                method: "POST",
              }) as unknown as BunRequest;

              return roleEntities.handlers.gql.handler(body.query, {}, request, session);
            }, "write"),
          },
        }
      : {}),
  };
};

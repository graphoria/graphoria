import type { TokenService } from "../authentication/types";
import type { AnalyzedConfiguration } from "../configuration";
import type { Configuration } from "../types/configuration";
import type { Env } from "../types/env";
import type { RateLimiter } from "../utils/rateLimit";
import type { BunRequest, SQL } from "bun";
import type { ConnectionPool } from "mssql";

import { createConsoleSessions } from "./session";
import { getTags } from "../configuration/rest/generateOpenAPI";
import { audit } from "../logging/audit";
import { getCronJobs } from "../singletons/cron";
import { databasesConnections } from "../singletons/databases";
import { queueManager } from "../singletons/queues";
import { resolveClientAddress } from "../utils/rateLimit";
import { S200, S400, S401, S404, S429 } from "../utils/responses";

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

const pingConnection = (connection: SQL | ConnectionPool, type: string) =>
  type === "mssql"
    ? (connection as ConnectionPool).query("SELECT 1")
    : (connection as SQL).unsafe("SELECT 1");

const measureLatency = async (connection: SQL | ConnectionPool, type: string) => {
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

  const clientAddress = (req: BunRequest, server?: Bun.Server<unknown>) =>
    resolveClientAddress(req, server, env.rateLimit.trustProxy);

  const guarded =
    (
      handler: (req: BunRequest, server?: Bun.Server<unknown>) => object | Promise<object>,
    ): ConsoleRouteHandler =>
    async (req: BunRequest, server?: Bun.Server<unknown>) => {
      try {
        if (!(await sessions.authorize(req))) return new S404({ error: "Not Found" });
        return new S200(await handler(req, server));
      } catch (error) {
        return new S400({ errors: [{ message: (error as Error)?.message }] });
      }
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
          const session = await sessions.login(req);
          audit().emit({
            action: "console.login",
            outcome: "success",
            actor,
            target: { kind: "console" },
          });
          return new S200(session);
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
      GET: guarded(() => ({
        name: projectConfiguration.name,
        version: projectConfiguration.version,
        prefixes,
        features: {
          auth: projectConfiguration.auth?.enabled ?? false,
          ai: projectConfiguration.ai?.enabled ?? false,
          mcp: projectConfiguration.ai?.mcp?.enabled ?? false,
          cors: env.enableCors,
        },
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
      }),
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
      }),
    },
  };
};

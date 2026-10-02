import { join } from "path";

import { serve } from "bun";
import { isString } from "es-toolkit";

import type { BunRequest } from "bun";
import type { Capability } from "./authentication/capabilities";
import type { Configuration } from "./types/configuration";
import type { Env } from "./types/env";
import type { SessionContext } from "./utils/sessionVariables";

import { createTokenService } from "./authentication";
import { analyzeConfiguration, loadConfiguration } from "./configuration";
import { buildExecute } from "./configuration/gql/buildExecute";
import { websocketHandlerFactory } from "./configuration/gql/handleGraphQLSubscriptionFactory";
import { consoleRoutesFactory } from "./console/api";
import { createAuthTables, verifyAuthTablesExist } from "./databases";
import { createMCPRoutes } from "./ai";
import { createCapabilityAuthorizer, scopedCredentialRole } from "./authentication/capabilities";
import { assertScopedRoles, getAgent, instantiateAI, resolveAISurfaces } from "./singletons/ai";
import { getTokenService, setTokenService } from "./singletons/authentication";
import { getCronJobs, instantiateCronJobs } from "./singletons/cron";
import {
  databasesConnections,
  disconnectDatabases,
  instantiateDatabasesConnections,
  pingConnection,
} from "./singletons/databases";
import { closeCacheRedisClient, getCacheRedisClient } from "./singletons/cache/redisClient";
import { env } from "./singletons/env";
import { setQueryTimeoutMs } from "./singletons/queryTimeout";
import { setSlowQueryMs } from "./logging/slowQuery";
import { instantiateQueues, queueManager } from "./singletons/queues";
import { ConfigurationZod } from "./types/zod/configuration";
import {
  createMemoryRateLimitStore,
  createRateLimiter,
  createRedisRateLimitStore,
  resolveClientAddress,
} from "./utils/rateLimit";
import { S200, S400, S401, S404, S429 } from "./utils/responses";
import { writeSchema } from "./utils/writeSchema";
import { logger, configureLogging } from "./logging";
import { actorFromSession, audit } from "./logging/audit";
import { createHealthRoutes } from "./observability/health";
import { configureMetrics, renderMetrics } from "./observability/metrics";
import { configureTracing, flushSpans } from "./observability/tracing";
import { withHttpMetrics } from "./observability/httpMetrics";
import { withHttpTracing } from "./observability/httpTracing";
import { createMetricsRoute } from "./observability/metricsRoute";
import { createShutdown, createSignalHandler, exitOnSignalDuringBoot } from "./shutdown";

// Re-export for consumers
export { configureLogging };

export type {
  QueueAdapter,
  QueueAdapterType,
  QueuePublisher,
  QueueRuntimeContext,
} from "./queues/adapter";
export type { KafkaConfig, QueueConfig, RabbitMQConfig } from "./types/zod/queue";
export type { QueueConnectionStatus, QueueManager } from "./singletons/queues";
export { setQueueAdapter } from "./singletons/queues";

type RouteHandler =
  | Response
  | ((req: BunRequest, server: Bun.Server<unknown>) => Response | Promise<Response | undefined>);

type RoutesMap = Record<string, RouteHandler | Record<string, RouteHandler>>;

const HEALTH_CHECK_TIMEOUT_MS = 2000;

const renderPlayground = async (filepath: string, replacements: Record<string, string>) => {
  const path = join(import.meta.dir, filepath);
  const content = await Bun.file(path).text();

  return Object.entries(replacements).reduce(
    (acc, [key, value]) => acc.replaceAll(`"{{${key}}}"`, JSON.stringify(value)),
    content,
  );
};

const html = (html: string) =>
  new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=300",
    },
  });

const generatePrefixes = (options: Env) => ({
  graphql: options.prefix + options.graphqlApiEndpoint,
  graphiql: options.prefix + options.graphiqlEndpoint,
  scalar: options.prefix + options.scalarEndpoint,
  rest: options.prefix + options.restApiPrefix,
  openapi: options.prefix + options.openApiEndpoint,
  console: options.prefix + options.console.endpoint,
  health: options.prefix + "/health",
  metrics: options.prefix + options.metrics.endpoint,
});

/**
 * Boot the request-independent core: load + validate configuration, connect
 * databases, select the token service, and build the per-role schemas. Shared
 * by {@link createGraphQLServer} (which adds routes) and
 * {@link createGraphQLEngine} (which adds in-process execution).
 */
const bootAnalyzedConfiguration = async (env: Env) => {
  // Inject custom logger before any subsystem creates one
  if (env.logger) {
    configureLogging(env.logger);
  }

  if (env.maxQueryDepth === 0) {
    logger("graphoria").warn(
      "MAX_QUERY_DEPTH=0 disables the query depth limit; one deeply nested query can exhaust the server",
    );
  }

  setQueryTimeoutMs(env.queryTimeoutMs);
  setSlowQueryMs(env.slowQueryMs);
  configureMetrics({
    enabled: env.metrics.enabled,
    maxOperationLabels: env.metrics.maxOperationLabels,
  });
  configureTracing({
    enabled: env.tracing.enabled,
    endpoint: env.tracing.endpoint,
    headers: env.tracing.headers,
    serviceName: env.tracing.serviceName,
    sampleRatio: env.tracing.sampleRatio,
  });

  if (env.queryTimeoutMs === 0) {
    logger("graphoria").warn(
      "QUERY_TIMEOUT_MS=0 disables the statement timeout; one slow query can hold a connection and its locks indefinitely",
    );
  }

  if (!env.configuration) {
    throw new Error("Configuration is required to create the GraphQL server");
  }

  // Load configuration if a path was given, otherwise validate the inline object
  const projectConfiguration: Configuration = isString(env.configuration)
    ? ConfigurationZod.parse(await loadConfiguration(env.configuration))
    : ConfigurationZod.parse(env.configuration);

  // Initialize databases (using pre-calculated enabledDatabases from parsing)
  await instantiateDatabasesConnections(
    projectConfiguration.enabledDatabases,
    env.dbConnectRetryMs,
  );

  // Initialize token service based on configured strategy. AUTH_STRATEGY env
  // var overrides the configuration field when set, so per-deploy strategy
  // selection (e.g. JWT in dev, PASETO in prod) works without rebuilding.
  const tokenStrategy = env.authStrategy ?? projectConfiguration.tokenStrategy;
  if (env.authStrategy && env.authStrategy !== projectConfiguration.tokenStrategy) {
    logger("graphoria").info(
      { authStrategy: env.authStrategy, configTokenStrategy: projectConfiguration.tokenStrategy },
      "auth strategy override",
    );
  }
  if (env.ai?.enabled !== undefined && env.ai.enabled !== projectConfiguration.ai.enabled) {
    logger("graphoria").info(
      { aiEnabled: env.ai.enabled, configAiEnabled: projectConfiguration.ai.enabled },
      "ai override",
    );
  }
  if (
    env.ai?.mcp?.enabled !== undefined &&
    env.ai.mcp.enabled !== projectConfiguration.ai.mcp.enabled
  ) {
    logger("graphoria").info(
      { mcpEnabled: env.ai.mcp.enabled, configMcpEnabled: projectConfiguration.ai.mcp.enabled },
      "mcp override",
    );
  }
  // Only auth (login, refresh) and the console (its session cookie) sign tokens;
  // with both off, a missing key just means bearer tokens are ignored.
  const keyRequired = Boolean(projectConfiguration.auth?.enabled) || env.console.enabled;
  setTokenService(createTokenService(env, tokenStrategy, keyRequired));

  // Analyze configuration
  const analyzedConfiguration = await analyzeConfiguration(projectConfiguration, env);

  return { projectConfiguration, analyzedConfiguration };
};

/**
 * Run GraphQL queries in-process against a configuration, without standing up
 * an HTTP server. Performs the same boot as {@link createBunServer} minus the
 * route / websocket / queue / cron layer, then returns an `execute` function.
 *
 * `execute(query, variables?, opts?)` runs the same introspection / no-data /
 * validation / dispatch pipeline as the `/graphql` endpoint. It bypasses auth:
 * `opts.role` selects the role (defaults to the superadmin role — full
 * privileges) and there is no token verification. Because no `BunRequest`
 * exists, request-dependent features (operation `init`/`beforeRequest` hooks
 * and header-derived session variables) do not run.
 *
 * @param env - Resolved env-shaped config (`Env`); same shape the server takes.
 *   The configured token strategy's keys are required when auth or the
 *   console is enabled.
 * @returns `{ execute, roles, close, logger }` — call `close()` to release
 *   database connections.
 *
 * @example
 * ```ts
 * import { createGraphQLEngine } from "@graphoria/server";
 *
 * const { execute, close } = await createGraphQLEngine({
 *   ...process.env,
 *   configuration: "./graphoria.ts",
 * } as Env);
 *
 * console.log(await execute("{ __typename }"));
 * await close();
 * ```
 */
export const createGraphQLEngine = async (options?: Partial<Env>) => {
  const optionsWithDefaults: Env = {
    ...env,
    ...options,
  };

  const { analyzedConfiguration } = await bootAnalyzedConfiguration(optionsWithDefaults);

  return {
    execute: buildExecute(analyzedConfiguration.roles, env.superadmin.role),
    roles: Object.keys(analyzedConfiguration.roles),
    close: disconnectDatabases,
    logger,
  };
};

/**
 * Build the request-time pieces of a Graphoria server: per-role GraphQL
 * schemas, a websocket handler, and a routes map ready to feed into
 * `Bun.serve`. Loads the configuration (path or inline object), connects
 * databases, instantiates queues and cron jobs, then assembles handlers.
 *
 * Internal — callers use {@link createBunServer} (full server),
 * {@link createHandlers} (handlers only), or {@link createGraphQLEngine}
 * (in-process query execution, no server).
 *
 * @param env - Resolved env-shaped config (`Env`). Required fields
 *   include `configuration` (path or `Configuration` object), `adminSecret`,
 *   and, when auth or the console is enabled, the chosen token strategy's keys
 *   (e.g. `jwtSecret`).
 * @returns `{ websocketHandler, closeWebsockets, routes, prefixes, logger,
 *   execute }` — `routes` is the map passed to `Bun.serve({ routes, websocket })`;
 *   `closeWebsockets(code, reason)` closes every open socket; `execute` runs a
 *   query in-process (see {@link createGraphQLEngine}); `logger` is the
 *   named-logger factory.
 */
const createGraphQLServer = async (env: Env) => {
  const { projectConfiguration, analyzedConfiguration } = await bootAnalyzedConfiguration(env);

  const aiSurfaces = resolveAISurfaces(env, projectConfiguration.ai);
  assertScopedRoles(env, analyzedConfiguration.roles, aiSurfaces);

  // Initialize queues
  await instantiateQueues(analyzedConfiguration.queues);

  await instantiateCronJobs(
    projectConfiguration.cron,
    analyzedConfiguration.roles[env.superadmin.role].handlers.gql.handler,
  );

  // The agent's prompts. Its tools are built per call, for the caller's role.
  if (aiSurfaces.agent) {
    instantiateAI(projectConfiguration.ai, {
      systemPrompt: env.ai?.systemPrompt,
      promptTemplate: env.ai?.promptTemplate,
    });
  }

  // Write schema in development
  if (env.schemas.print) {
    await writeSchema(analyzedConfiguration.roles, env.schemas.outputDir);
  }

  if (projectConfiguration.auth?.enabled) {
    if (projectConfiguration.auth.autoCreateTables) {
      await createAuthTables(projectConfiguration.auth);
    } else {
      await verifyAuthTablesExist(projectConfiguration.auth);
    }
  }

  const prefixes = generatePrefixes(env);

  const graphiqlFile = await renderPlayground("../playgrounds/graphiql/index.html", {
    GRAPHQL_URL: prefixes.graphql,
  });

  const scalarFile = await renderPlayground("../playgrounds/scalar/index.html", {
    OPENAPI_URL: prefixes.openapi,
    REST_PREFIX: prefixes.rest,
  });

  const consoleHtml = await renderPlayground("../playgrounds/console/index.html", {});

  const rateLimiter = createRateLimiter({
    settings: env.rateLimit,
    anonymousRole: env.anonymousRole,
    permissions: projectConfiguration.auth?.permissions,
    store: () =>
      env.cache.store === "redis"
        ? createRedisRateLimitStore(getCacheRedisClient())
        : createMemoryRateLimitStore(),
  });

  const authorizeCapability = createCapabilityAuthorizer(env);

  // Helper to get role-based handlers. A route that names a capability also
  // accepts that capability's scoped credential in the admin-secret header; it
  // stands in for the role `scopedCredentialRole` names, on that route and
  // nowhere else.
  const getRoleHandlers = async (
    req: Request,
    server?: Bun.Server<unknown>,
    capability?: Capability,
  ) => {
    const adminSecretHeader = req.headers.get(env.admin.header);
    const grant = capability ? authorizeCapability(adminSecretHeader, capability) : null;

    const session: SessionContext =
      capability && grant && !grant.superset
        ? {
            sub: capability,
            role: scopedCredentialRole(env, capability),
            authMethod: "admin_secret",
          }
        : await getTokenService().verifyTokenAndGetSession(
            req.headers.get(env.authorizationHeader),
            adminSecretHeader,
          );

    const ip = resolveClientAddress(req, server, env.rateLimit.trustProxy);

    // The limit needs the role, and the role costs a token verification plus a
    // revocation lookup — so it is spent here, once, rather than again inside a
    // wrapper.
    const limit = await rateLimiter?.check(session, ip);

    const scope: Capability | "all" | undefined = grant
      ? grant.superset
        ? "all"
        : capability
      : undefined;

    if (session.authMethod === "admin_secret") {
      audit().emit({
        action: "admin_secret.used",
        actor: { type: "admin_secret", ...(scope ? { scope } : {}), ip },
        target: { kind: "endpoint", method: req.method, path: new URL(req.url).pathname },
      });
    }

    return {
      role: session.role!,
      session,
      scope,
      limit,
      ...analyzedConfiguration.roles[session.role!].handlers,
    };
  };

  /**
   * For the entry points that have no session to key on: the websocket upgrade
   * (the token arrives in `connection_init`, after the upgrade) and MCP's 405 answers. They
   * are keyed by address against the anonymous ceiling.
   */
  const withRateLimit =
    <T>(handler: (req: BunRequest, server: Bun.Server<unknown>) => T | Promise<T>) =>
    async (req: BunRequest, server: Bun.Server<unknown>) => {
      const limit = await rateLimiter?.check(
        null,
        resolveClientAddress(req, server, env.rateLimit.trustProxy),
      );

      if (limit && !limit.allowed) return new S429(limit.retryAfterMs);

      return handler(req, server);
    };

  // Create routes map with all handlers
  const routes: RoutesMap = {};

  // CORS preflight handler
  if (env.enableCors) {
    routes[`${env.prefix}/*`] = { OPTIONS: () => new S200(null) };
  }

  // Static routes
  routes[prefixes.openapi] = () => new S200(analyzedConfiguration.openapi);
  routes[prefixes.graphiql] = () => html(graphiqlFile);
  routes[prefixes.scalar] = () => html(scalarFile);

  // Probes for an orchestrator: no auth, no rate limit. Redis is a dependency
  // only where something reads it — the token repository or the redis cache.
  const redisInUse = projectConfiguration.auth?.enabled || env.cache.store === "redis";
  Object.assign(
    routes,
    createHealthRoutes({
      basePath: prefixes.health,
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      checks: () => [
        ...analyzedConfiguration.databases.map((database) => ({
          kind: "database",
          name: database.name,
          probe: async () => {
            const connection = databasesConnections[database.name];
            if (!connection) return false;
            await pingConnection(connection, database.type);
            return true;
          },
        })),
        ...(redisInUse
          ? [{ kind: "redis", probe: async () => (await getCacheRedisClient().ping()) === "PONG" }]
          : []),
        ...(queueManager?.connections() ?? []).map(({ type, name, connected }) => ({
          kind: type,
          name,
          probe: () => connected,
        })),
      ],
    }),
  );

  // Prometheus exposition, opt-in via METRICS_ENABLED. Gated: the series name
  // operations, roles and databases.
  if (env.metrics.enabled) {
    Object.assign(
      routes,
      createMetricsRoute({
        path: prefixes.metrics,
        secretHeader: env.admin.header,
        authorize: (candidate) => authorizeCapability(candidate, "metrics"),
        render: renderMetrics,
      }),
    );
  }

  // Console (admin UI + status APIs), opt-in via CONSOLE_ENABLED
  if (env.console.enabled) {
    const consoleHandler = () => html(consoleHtml);
    routes[prefixes.console] = consoleHandler;
    routes[`${prefixes.console}/`] = consoleHandler;
    Object.assign(
      routes,
      consoleRoutesFactory({
        env,
        consolePath: prefixes.console,
        prefixes,
        projectConfiguration,
        analyzedConfiguration,
        tokenService: getTokenService(),
        rateLimiter,
      }),
    );
  }

  // GraphQL endpoint
  routes[prefixes.graphql] = {
    ...(env.enableCors ? { OPTIONS: () => new S200(null) } : {}),
    GET: withHttpTracing(
      "graphql",
      withHttpMetrics(
        "graphql",
        withRateLimit(async (req: Request, server: Bun.Server<unknown>) => {
          try {
            if (req.headers.get("upgrade") === "websocket") {
              const success = server.upgrade(req, {
                data: {},
              });
              return success ? undefined : new Response("WebSocket upgrade error", { status: 400 });
            }
            return new S404({ error: "Not Found" });
          } catch (error) {
            return new S400({ errors: [{ message: (error as Error)?.message }] });
          }
        }),
      ),
    ),
    POST: withHttpTracing(
      "graphql",
      withHttpMetrics("graphql", async (req: BunRequest, server: Bun.Server<unknown>) => {
        try {
          const { gql, session, limit } = await getRoleHandlers(req, server);
          if (limit && !limit.allowed) return new S429(limit.retryAfterMs);

          const { query, variables } = await req.json();

          if (gql.isIntrospectionQuery(query)) return new S200(gql.introspectionResult);

          if (gql.isNoDataQuery(query)) return new S200(gql.noDataResult);

          const { hasErrors, validationErrors } = gql.hasErrors(query, { variables });

          if (hasErrors)
            return new S400({
              errors: validationErrors.map((error) => ({
                message: error.message,
                locations: error.locations,
              })),
            });

          return new S200(await gql.handler(query, variables, req, session));
        } catch (error) {
          const message = (error as Error)?.message;

          if (message === "Invalid username or password") {
            return new S401({ errors: [{ message }] });
          } else {
            return new S400({ errors: [{ message }] });
          }
        }
      }),
    ),
  };

  // The AI agent over REST, for the roles granted `ai`
  if (aiSurfaces.rest) {
    const aiPath = `${prefixes.rest}${projectConfiguration.ai.endpoint}`;
    routes[aiPath] = {
      ...(env.enableCors ? { OPTIONS: () => new S200(null) } : {}),
      POST: async (req: BunRequest, server: Bun.Server<unknown>) => {
        try {
          const { role, session, scope, limit } = await getRoleHandlers(req, server, "ai");
          if (limit && !limit.allowed) return new S429(limit.retryAfterMs);
          // A role without the grant sees no route, as it sees no `ask` field.
          const roleSchema = analyzedConfiguration.roles[role];
          if (!roleSchema?.entityOfRole.ai) return new S404({ error: "Not Found" });

          const { prompt } = await req.json();
          if (typeof prompt !== "string" || prompt.length === 0)
            return new S400({
              errors: [{ message: "`prompt` (string) is required" }],
            });

          audit().emit({
            action: "ai.ask",
            actor: { ...actorFromSession(session), ...(scope ? { scope } : {}) },
            target: { kind: "ai", via: "rest" },
            prompt,
          });

          return new S200({
            answer: await getAgent()(prompt, { role: roleSchema, session, req }),
          });
        } catch (error) {
          return new S400({ errors: [{ message: (error as Error)?.message }] });
        }
      },
    };
  }

  // MCP calls no LLM, so it does not wait on the agent being enabled. A POST runs
  // as its caller, resolved like /graphql.
  if (aiSurfaces.mcp) {
    const mcpPath = `${env.prefix}${env.ai?.mcp?.endpoint ?? "/mcp"}`;
    const mcpRoutes = createMCPRoutes(analyzedConfiguration, {
      name: projectConfiguration.name,
      version: projectConfiguration.version,
      maxQueryDepth: env.ai?.mcp?.maxQueryDepth ?? env.maxQueryDepth,
      disabledTools: env.ai?.mcp?.disabledTools,
      disabledResources: env.ai?.mcp?.disabledResources,
      disabledPrompts: env.ai?.mcp?.disabledPrompts,
      requireAdminSecret: env.ai?.mcp?.requireAdminSecret,
      resolveCaller: (req, server) => getRoleHandlers(req, server, "mcp"),
      openapiFor: analyzedConfiguration.openapiFor,
    });

    // POST spends the caller's own bucket inside resolveCaller; GET and DELETE
    // answer 405 without resolving one, so they stay keyed by address.
    routes[mcpPath] = {
      POST: mcpRoutes.POST,
      GET: withRateLimit(mcpRoutes.GET),
      DELETE: withRateLimit(mcpRoutes.DELETE),
    };
  }

  // REST API endpoint
  routes[`${prefixes.rest}/*`] = withHttpTracing(
    "rest",
    withHttpMetrics("rest", async (req: BunRequest, server: Bun.Server<unknown>) => {
      if (req.method === "OPTIONS" && env.enableCors) return new S200(null);

      try {
        const { rest, session, limit } = await getRoleHandlers(req, server);
        if (limit && !limit.allowed) return new S429(limit.retryAfterMs);

        const urlParsed = new URL(req.url);

        return await rest.handler(
          urlParsed,
          urlParsed.pathname.replace(prefixes.rest, ""),
          req.method,
          req,
          session,
        );
      } catch {
        return new S400({ errors: [{ message: "Bad request" }] });
      }
    }),
  );

  // Create WebSocket handler
  const { handler: websocketHandler, closeAll: closeWebsockets } = websocketHandlerFactory(
    analyzedConfiguration.roles,
    env.admin.header,
  );

  return {
    websocketHandler,
    closeWebsockets,
    routes,
    prefixes,
    logger,
    execute: buildExecute(analyzedConfiguration.roles, env.superadmin.role),
  };
};

/**
 * Build the inputs to `Bun.serve()` without actually starting the server.
 * Wraps {@link createGraphQLServer} and packages the result as
 * `{ serverHandlers, options, prefixes }` where `serverHandlers` is the
 * literal argument shape `Bun.serve` expects.
 *
 * Use this when the caller wants to start the server itself (custom
 * lifecycle, multiple ports, integration tests).
 *
 * @param options - Partial overrides merged on top of `env` defaults.
 * @returns `{ serverHandlers, options: Env, prefixes, logger, execute, shutdown,
 *   handleSignals }` — `execute` runs a query in-process (see
 *   {@link createGraphQLEngine}); `shutdown(server)` drains the server, then
 *   closes cron, queues, Redis, database pools and pending spans, resolving
 *   `true` when all of it was clean; `handleSignals(server)` runs `shutdown` on
 *   SIGTERM / SIGINT, then exits 0 (clean) or 1.
 *
 * @example
 * ```ts
 * import { serve } from "bun";
 * import { createHandlers } from "@graphoria/server";
 *
 * const { serverHandlers, logger, handleSignals } = await createHandlers({ port: 4000 });
 * logger("my-app").info("starting");
 * handleSignals(serve(serverHandlers));
 * ```
 */
export async function createHandlers(options?: Partial<Env>) {
  const optionsWithDefaults: Env = {
    ...env,
    ...options,
  };

  const { websocketHandler, closeWebsockets, routes, prefixes, execute } =
    await createGraphQLServer(optionsWithDefaults);

  const shutdown = createShutdown({
    timeoutMs: optionsWithDefaults.shutdown.timeoutMs,
    stopIntake: [
      { name: "websockets", run: () => closeWebsockets(1001, "server shutting down") },
      { name: "cron", run: () => getCronJobs()?.stopAll() },
    ],
    // Queues close after the drain: a drained mutation can still publish.
    teardown: [
      { name: "queues", run: () => queueManager?.cleanup?.() },
      { name: "cache redis", run: closeCacheRedisClient },
      { name: "token redis", run: () => getTokenService().close() },
      { name: "databases", run: disconnectDatabases },
      { name: "spans", run: flushSpans },
    ],
  });

  return {
    serverHandlers: {
      port: optionsWithDefaults.port,
      websocket: websocketHandler,
      routes,
    },
    options: optionsWithDefaults,
    prefixes,
    logger,
    execute,
    shutdown,
    handleSignals: createSignalHandler(shutdown),
  };
}

/**
 * One-call setup: build the handlers and start a `Bun.serve` instance.
 * The returned `server` is the live `Bun.Server`. `prefixes` is the resolved
 * set of route prefixes (graphql, rest, openapi, graphiql, scalar) for
 * client-side reference.
 *
 * SIGTERM and SIGINT drain the server and exit (see {@link createHandlers}'s
 * `handleSignals`) unless `SHUTDOWN_HANDLE_SIGNALS=false`. One received before
 * the server listens exits 0 at once.
 *
 * @param options - Partial overrides merged on top of `env` defaults.
 * @returns `{ server, prefixes, logger, execute, shutdown }` — `logger(name)`
 *   mints a component-named logger sharing the server's pino root (and any
 *   {@link configureLogging} / `env.logger` override); `execute` runs a query
 *   in-process against the same schema (see {@link createGraphQLEngine});
 *   `shutdown()` drains this server and closes everything it opened, without
 *   exiting.
 *
 * @example
 * ```ts
 * import { createBunServer } from "@graphoria/server";
 *
 * const { server, prefixes, logger } = await createBunServer();
 * const log = logger("my-app");
 * log.info(`GraphQL: http://localhost:${server.port}${prefixes.graphql}`);
 * ```
 */
export async function createBunServer(options?: Partial<Env>) {
  const releaseBootSignals = { ...env, ...options }.shutdown.handleSignals
    ? exitOnSignalDuringBoot()
    : undefined;

  const {
    serverHandlers,
    options: resolved,
    prefixes,
    execute,
    shutdown,
    handleSignals,
  } = await createHandlers(options).finally(() => releaseBootSignals?.());

  const server = serve(serverHandlers);

  if (resolved.shutdown.handleSignals) handleSignals(server);

  return {
    server,
    prefixes,
    logger,
    execute,
    shutdown: () => shutdown(server),
  };
}

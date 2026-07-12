import { join } from "path";

import { serve } from "bun";
import { isString } from "es-toolkit";

import type { BunRequest } from "bun";
import type { Configuration } from "./types/configuration";
import type { Env } from "./types/env";

import { createTokenService } from "./authentication";
import { analyzeConfiguration, loadConfiguration } from "./configuration";
import { buildExecute } from "./configuration/gql/buildExecute";
import { websocketHandlerFactory } from "./configuration/gql/handleGraphQLSubscriptionFactory";
import { consoleRoutesFactory } from "./console/api";
import { createAuthTables, verifyAuthTablesExist } from "./databases";
import { createMCPRoutes } from "./ai";
import { getAgent, instantiateAI } from "./singletons/ai";
import { getTokenService, setTokenService } from "./singletons/authentication";
import { instantiateCronJobs } from "./singletons/cron";
import { disconnectDatabases, instantiateDatabasesConnections } from "./singletons/databases";
import { env } from "./singletons/env";
import { instantiateQueues } from "./singletons/queues";
import { ConfigurationZod } from "./types/zod/configuration";
import { S200, S400, S401, S404 } from "./utils/responses";
import { writeSchema } from "./utils/writeSchema";
import { logger, configureLogging } from "./logging";

// Re-export for consumers
export { configureLogging };

type RouteHandler =
  | Response
  | ((req: BunRequest, server: Bun.Server<unknown>) => Response | Promise<Response | undefined>);

type RoutesMap = Record<string, RouteHandler | Record<string, RouteHandler>>;

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

  if (!env.configuration) {
    throw new Error("Configuration is required to create the GraphQL server");
  }

  // Load configuration if a path was given, otherwise validate the inline object
  const projectConfiguration: Configuration = isString(env.configuration)
    ? ConfigurationZod.parse(await loadConfiguration(env.configuration))
    : ConfigurationZod.parse(env.configuration);

  // Initialize databases (using pre-calculated enabledDatabases from parsing)
  await instantiateDatabasesConnections(projectConfiguration.enabledDatabases);

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
  setTokenService(createTokenService(env, tokenStrategy));

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
 *   The configured token strategy's keys are still required.
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
 *   and the chosen token strategy's keys (e.g. `jwtSecret`).
 * @returns `{ websocketHandler, routes, prefixes, logger, execute }` — `routes`
 *   is the map passed to `Bun.serve({ routes, websocket })`; `execute` runs a
 *   query in-process (see {@link createGraphQLEngine}); `logger` is the
 *   named-logger factory.
 */
const createGraphQLServer = async (env: Env) => {
  const { projectConfiguration, analyzedConfiguration } = await bootAnalyzedConfiguration(env);

  // Initialize queues
  await instantiateQueues(analyzedConfiguration.queues);

  await instantiateCronJobs(
    projectConfiguration.cron,
    analyzedConfiguration.roles[env.superadmin.role].handlers.gql.handler,
  );

  // Initialize the AI agent (admin-only), bound to the superadmin schema
  if (projectConfiguration.ai?.enabled) {
    instantiateAI(projectConfiguration.ai, analyzedConfiguration.roles[env.superadmin.role], {
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

  // Helper to get role-based handlers
  const getRoleHandlers = async (req: Request) => {
    const session = await getTokenService().verifyTokenAndGetSession(
      req.headers.get(env.authorizationHeader),
      req.headers.get(env.admin.header),
    );
    return {
      role: session.role!,
      session,
      ...analyzedConfiguration.roles[session.role!].handlers,
    };
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
        getRoleHandlers,
      }),
    );
  }

  // GraphQL endpoint
  routes[prefixes.graphql] = {
    ...(env.enableCors ? { OPTIONS: () => new S200(null) } : {}),
    GET: async (req: Request, server: Bun.Server<unknown>) => {
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
    },
    POST: async (req: BunRequest) => {
      try {
        const { gql, session } = await getRoleHandlers(req);
        const { query, variables } = await req.json();

        if (gql.isIntrospectionQuery(query)) return new S200(gql.introspectionResult);

        if (gql.isNoDataQuery(query)) return new S200(gql.noDataResult);

        const { hasErrors, validationErrors } = gql.hasErrors(query);

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
    },
  };

  const aiEnabled = projectConfiguration.ai?.enabled ?? false;

  // AI agent endpoint (admin-secret only)
  if (aiEnabled) {
    const mcpEnabled = env.ai?.mcp?.enabled ?? projectConfiguration.ai?.mcp?.enabled ?? false;

    if (mcpEnabled) {
      const mcpPath = `${env.prefix}${env.ai?.mcp?.endpoint ?? projectConfiguration.ai?.endpoint ?? "/ai"}`;
      routes[mcpPath] = createMCPRoutes(analyzedConfiguration, {
        ...(env.ai?.mcp ?? {}),
        name: projectConfiguration.name,
        version: projectConfiguration.version,
        maxQueryDepth: env.ai?.mcp?.maxQueryDepth ?? env.maxQueryDepth,
        adminSecret: env.admin.secret,
        adminSecretHeader: env.admin.header,
      });
    }

    if (env.ai?.restEnabled) {
      const aiPath = `${env.prefix}/rest${projectConfiguration.ai.endpoint ?? "/ai"}`;
      routes[aiPath] = {
        ...(env.enableCors ? { OPTIONS: () => new S200(null) } : {}),
        POST: async (req: BunRequest) => {
          try {
            const { role } = await getRoleHandlers(req);
            if (role !== env.superadmin.role) return new S404({ error: "Not Found" });

            const { prompt } = await req.json();
            if (typeof prompt !== "string" || prompt.length === 0)
              return new S400({
                errors: [{ message: "`prompt` (string) is required" }],
              });

            return new S200({ answer: await getAgent()(prompt) });
          } catch (error) {
            return new S400({ errors: [{ message: (error as Error)?.message }] });
          }
        },
      };
    }
  }

  // REST API endpoint
  routes[`${prefixes.rest}/*`] = async (req: BunRequest) => {
    if (req.method === "OPTIONS" && env.enableCors) return new S200(null);

    try {
      const { rest, session } = await getRoleHandlers(req);

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
  };

  // Create WebSocket handler
  const websocketHandler = websocketHandlerFactory(analyzedConfiguration.roles);

  return {
    websocketHandler,
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
 * @returns `{ serverHandlers, options: Env, prefixes, logger, execute }` —
 *   `execute` runs a query in-process (see {@link createGraphQLEngine}).
 *
 * @example
 * ```ts
 * import { serve } from "bun";
 * import { createHandlers } from "@graphoria/server";
 *
 * const { serverHandlers, logger } = await createHandlers({ port: 4000 });
 * logger("my-app").info("starting");
 * serve(serverHandlers);
 * ```
 */
export async function createHandlers(options?: Partial<Env>) {
  const optionsWithDefaults: Env = {
    ...env,
    ...options,
  };

  const { websocketHandler, routes, prefixes, execute } =
    await createGraphQLServer(optionsWithDefaults);

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
  };
}

/**
 * One-call setup: build the handlers and start a `Bun.serve` instance.
 * The returned `server` is the live `Bun.Server` — call `server.stop()` to
 * shut it down. `prefixes` is the resolved set of route prefixes (graphql,
 * rest, openapi, graphiql, scalar) for client-side reference.
 *
 * @param options - Partial overrides merged on top of `env` defaults.
 * @returns `{ server, prefixes, logger, execute }` — `logger(name)` mints a
 *   component-named logger sharing the server's pino root (and any
 *   {@link configureLogging} / `env.logger` override); `execute` runs a query
 *   in-process against the same schema (see {@link createGraphQLEngine}).
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
  const { serverHandlers, prefixes, execute } = await createHandlers(options);

  const server = serve(serverHandlers);

  return {
    server,
    prefixes,
    logger,
    execute,
  };
}

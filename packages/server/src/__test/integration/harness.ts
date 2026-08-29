import { SQL } from "bun";
import { ConnectionPool } from "mssql";
import { generateKeys } from "paseto-ts/v4";

import type { ConfigurationInput } from "../../config";
import type { DatabaseType } from "../../types/configuration";

import { CONNECTIONS, INTEGRATION_ENABLED, MYSQL_CONNECTION_OPTIONS, REDIS_URL } from "./config";
import { seedEngine } from "./seed";

/**
 * Boots a real Graphoria server against a real database engine.
 *
 * The server comes up through `createBunServer`, the same entry point users
 * call, so the harness exercises the real boot path rather than a test double.
 * Requests go over HTTP against an ephemeral port for the same reason.
 *
 * The suite is gated behind INTEGRATION=1 and needs `docker-compose.test.yml`
 * running.
 */

// The env singleton parses process.env at import time and requires these, so
// they must be set before the server module is pulled in. That is also why the
// server is imported dynamically inside `withServer` rather than at the top.
process.env["ADMIN_SECRET"] ??= "integration-admin-secret";
process.env["JWT_SECRET"] ??= "integration-jwt-secret-integration-jwt-secret";
process.env["REDIS_URL"] ??= REDIS_URL;
process.env["LOG_LEVEL"] ??= "silent";

// The PASETO strategies validate their keys when the token service is built, so
// both key sets have to exist before the env singleton parses — even for the
// suites that only ever run under the default `jwt` strategy.
const pasetoPublicKeys = generateKeys("public") as { secretKey: string; publicKey: string };
process.env["PASETO_LOCAL_KEY"] ??= generateKeys("local") as string;
process.env["PASETO_SECRET_KEY"] ??= pasetoPublicKeys.secretKey;
process.env["PASETO_PUBLIC_KEY"] ??= pasetoPublicKeys.publicKey;

// Redis is part of the compose stack, so the integration suite exercises the
// Redis cache store rather than the in-memory one. Only operations that declare
// a `cache` block ever construct it.
process.env["CACHE_STORE"] ??= "redis";

export type GraphQLResponse<T = Record<string, unknown>> = {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

export type RequestOptions = {
  /** Sends the admin secret header, which bypasses RBAC (superadmin role). */
  admin?: boolean;
  token?: string;
  /** Raw `Cookie` header value — `auth_refresh` reads the refresh token from one. */
  cookie?: string;
  headers?: Record<string, string>;
};

export type IntegrationContext = {
  engine: DatabaseType;
  server: Awaited<ReturnType<typeof import("../../index").createBunServer>>["server"];
  /** Runs a GraphQL document over HTTP against the booted server. */
  gql: <T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    options?: RequestOptions,
  ) => Promise<GraphQLResponse<T>>;
  /** Same as `gql` but hands back the raw response, for `Set-Cookie` assertions. */
  gqlRaw: (
    query: string,
    variables?: Record<string, unknown>,
    options?: RequestOptions,
  ) => Promise<Response>;
  /** Runs a REST request against the booted server. `path` is prefix-relative. */
  rest: (path: string, init?: RequestInit & RequestOptions) => Promise<Response>;
  /** Runs raw SQL against the engine, bypassing Graphoria entirely. */
  sql: <T = Record<string, unknown>>(statement: string) => Promise<T[]>;
  /** Opens a graphql-ws connection, authenticates it, and starts one subscription. */
  subscribe: (query: string, options?: SubscribeOptions) => Promise<SubscriptionClient>;
};

export type SubscribeOptions = RequestOptions & {
  variables?: Record<string, unknown>;
  /** graphql-ws operation id. Only matters when one socket runs several. */
  id?: string;
};

export type SubscriptionMessage = {
  id?: string;
  type: string;
  payload?: unknown;
};

export type SubscriptionClient = {
  /** Every message the server has sent, in order. */
  received: SubscriptionMessage[];
  /** The next message the server sends, or a rejection once `timeoutMs` passes. */
  next: (timeoutMs?: number) => Promise<SubscriptionMessage>;
  /** The `data` object of the next `next` message. Rejects on an `error` message. */
  nextData: <T = Record<string, unknown>>(timeoutMs?: number) => Promise<T>;
  close: () => void;
};

export type WithServerOptions = {
  engine: DatabaseType;
  /** Merged over the default configuration before it is parsed. */
  config?: Partial<ConfigurationInput>;
  /** Skip the schema drop/create/seed cycle when a previous call already ran it. */
  skipSeed?: boolean;
  /** Merged over the env singleton, for settings that are env-shaped only. */
  env?: Partial<import("../../types/env").Env>;
};

const baseConfig = (engine: DatabaseType): ConfigurationInput => ({
  name: "graphoria-integration",
  version: "1.0.0",
  databases: [
    engine === "mysql"
      ? {
          name: "default",
          enabled: true,
          type: engine,
          connection: { ...CONNECTIONS.mysql },
          connectionOptions: MYSQL_CONNECTION_OPTIONS,
        }
      : {
          name: "default",
          enabled: true,
          type: engine,
          connection: { ...CONNECTIONS[engine] },
        },
  ],
  auth: {
    enabled: false,
    database: "",
    permissions: {
      anonymous: { tables: "ALL", storedProcedures: "ALL" },
    },
  },
});

const rawClient = async (engine: DatabaseType) => {
  if (engine === "mssql") {
    const pool = await new ConnectionPool({
      server: CONNECTIONS.mssql.host,
      port: CONNECTIONS.mssql.port,
      user: CONNECTIONS.mssql.user,
      password: CONNECTIONS.mssql.password,
      database: CONNECTIONS.mssql.database,
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
    }).connect();

    return {
      query: async <T>(statement: string) =>
        (await pool.request().query(statement)).recordset as T[],
      close: () => pool.close(),
    };
  }

  const client = new SQL({
    hostname: CONNECTIONS[engine].host,
    port: CONNECTIONS[engine].port,
    username: CONNECTIONS[engine].user,
    password: CONNECTIONS[engine].password,
    database: CONNECTIONS[engine].database,
    ...(engine === "mysql" ? { adapter: "mysql" as const, ...MYSQL_CONNECTION_OPTIONS } : {}),
    max: 2,
  });

  return {
    query: async <T>(statement: string) => (await client.unsafe(statement)) as T[],
    close: () => client.close(),
  };
};

export type StartedServer = {
  context: IntegrationContext;
  /** Closes the raw client, the server, and every database pool. */
  stop: () => Promise<void>;
};

/**
 * Boots a server for `engine` and hands back the context plus its teardown.
 *
 * Use this from `beforeAll`/`afterAll` when a file runs many assertions against
 * one database — booting per test costs an introspection round-trip each time.
 * `withServer` wraps it for the single-shot case.
 */
export const startServer = async (options: WithServerOptions): Promise<StartedServer> => {
  const { engine, config, skipSeed, env } = options;

  if (!skipSeed) await seedEngine(engine);

  const { createBunServer } = await import("../../index");
  const { disconnectDatabases } = await import("../../singletons/databases");

  const { server, prefixes } = await createBunServer({
    port: 0,
    ...env,
    configuration: { ...baseConfig(engine), ...config } as never,
  });

  const raw = await rawClient(engine);

  const url = (path: string) => `http://localhost:${server.port}${path}`;

  const authHeaders = (requestOptions?: RequestOptions): Record<string, string> => ({
    ...(requestOptions?.admin ? { "x-admin-secret": process.env["ADMIN_SECRET"]! } : {}),
    ...(requestOptions?.token ? { authorization: `Bearer ${requestOptions.token}` } : {}),
    ...(requestOptions?.cookie ? { cookie: requestOptions.cookie } : {}),
    ...requestOptions?.headers,
  });

  const gqlRaw = (
    query: string,
    variables?: Record<string, unknown>,
    requestOptions?: RequestOptions,
  ) =>
    Bun.fetch(url(prefixes.graphql), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(requestOptions) },
      body: JSON.stringify({ query, variables }),
    });

  /**
   * A graphql-ws client that is connected, acknowledged and subscribed by the
   * time it is handed back, so a test never has to sleep to find out whether
   * the socket came up. Messages are queued rather than dropped: a subscription
   * that answers before `next()` is called still delivers.
   */
  const subscribe = async (
    query: string,
    options: SubscribeOptions = {},
  ): Promise<SubscriptionClient> => {
    const socket = new WebSocket(`ws://localhost:${server.port}${prefixes.graphql}`);
    const received: SubscriptionMessage[] = [];
    const queue: SubscriptionMessage[] = [];
    const waiting: ((message: SubscriptionMessage) => void)[] = [];

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as SubscriptionMessage;
      received.push(message);
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    };

    const next = (timeoutMs = 10_000): Promise<SubscriptionMessage> => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.indexOf(settle);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error(`no subscription message within ${timeoutMs}ms`));
        }, timeoutMs);

        const settle = (message: SubscriptionMessage) => {
          clearTimeout(timer);
          resolve(message);
        };

        waiting.push(settle);
      });
    };

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("websocket failed to open"));
    });

    socket.send(
      JSON.stringify({
        type: "connection_init",
        payload: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.admin ? { headers: { "x-admin-secret": process.env["ADMIN_SECRET"]! } } : {}),
        },
      }),
    );

    const ack = await next();
    if (ack.type !== "connection_ack") {
      throw new Error(`expected connection_ack, got ${JSON.stringify(ack)}`);
    }

    socket.send(
      JSON.stringify({
        id: options.id ?? "1",
        type: "subscribe",
        payload: { query, variables: options.variables },
      }),
    );

    const nextData = async <T = Record<string, unknown>>(timeoutMs?: number): Promise<T> => {
      const message = await next(timeoutMs);
      if (message.type !== "next") {
        throw new Error(`expected a next message, got ${JSON.stringify(message)}`);
      }
      return (message.payload as { data: T }).data;
    };

    return { received, next, nextData, close: () => socket.close() };
  };

  const context: IntegrationContext = {
    engine,
    server,
    gqlRaw,
    subscribe,
    gql: async (query, variables, requestOptions) =>
      (await gqlRaw(query, variables, requestOptions)).json(),
    rest: (path, init) =>
      Bun.fetch(url(`${prefixes.rest}${path}`), {
        ...init,
        headers: { ...authHeaders(init), ...(init?.headers as Record<string, string>) },
      }),
    sql: (statement) => raw.query(statement),
  };

  return {
    context,
    stop: async () => {
      await raw.close();
      server.stop(true);
      await disconnectDatabases();
    },
  };
};

/**
 * Boots a server for `engine`, hands the context to `fn`, and tears everything
 * down again — including database pools, so a test file leaves no open handles.
 */
export const withServer = async <T>(
  options: WithServerOptions,
  fn: (context: IntegrationContext) => Promise<T>,
): Promise<T> => {
  const { context, stop } = await startServer(options);

  try {
    return await fn(context);
  } finally {
    await stop();
  }
};

/**
 * `describe` that no-ops unless INTEGRATION=1, so the fast unit suite stays
 * runnable without Docker.
 */
export const integrationEnabled = INTEGRATION_ENABLED;

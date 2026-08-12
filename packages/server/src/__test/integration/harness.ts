import { SQL } from "bun";
import { ConnectionPool } from "mssql";

import type { ConfigurationInput } from "../../config";
import type { DatabaseType } from "../../types/configuration";

import {
  CONNECTIONS,
  INTEGRATION_ENABLED,
  REDIS_URL,
  UNSUPPORTED_IDENTIFIER_TABLES,
} from "./config";
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

export type GraphQLResponse<T = Record<string, unknown>> = {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

export type RequestOptions = {
  /** Sends the admin secret header, which bypasses RBAC (superadmin role). */
  admin?: boolean;
  token?: string;
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
  /** Runs a REST request against the booted server. `path` is prefix-relative. */
  rest: (path: string, init?: RequestInit & RequestOptions) => Promise<Response>;
  /** Runs raw SQL against the engine, bypassing Graphoria entirely. */
  sql: <T = Record<string, unknown>>(statement: string) => Promise<T[]>;
};

export type WithServerOptions = {
  engine: DatabaseType;
  /** Merged over the default configuration before it is parsed. */
  config?: Partial<ConfigurationInput>;
  /** Skip the schema drop/create/seed cycle when a previous call already ran it. */
  skipSeed?: boolean;
};

const baseConfig = (engine: DatabaseType): ConfigurationInput => ({
  name: "graphoria-integration",
  version: "1.0.0",
  databases: [
    {
      name: "default",
      enabled: true,
      type: engine,
      connection: { ...CONNECTIONS[engine] },
      schema: { excludedTables: UNSUPPORTED_IDENTIFIER_TABLES(engine) },
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
    ...(engine === "mysql" ? { adapter: "mysql" as const } : {}),
    max: 2,
  });

  return {
    query: async <T>(statement: string) => (await client.unsafe(statement)) as T[],
    close: () => client.close(),
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
  const { engine, config, skipSeed } = options;

  if (!skipSeed) await seedEngine(engine);

  const { createBunServer } = await import("../../index");
  const { disconnectDatabases } = await import("../../singletons/databases");

  const { server, prefixes } = await createBunServer({
    port: 0,
    configuration: { ...baseConfig(engine), ...config } as never,
  });

  const raw = await rawClient(engine);

  const url = (path: string) => `http://localhost:${server.port}${path}`;

  const authHeaders = (requestOptions?: RequestOptions): Record<string, string> => ({
    ...(requestOptions?.admin ? { "x-admin-secret": process.env["ADMIN_SECRET"]! } : {}),
    ...(requestOptions?.token ? { authorization: `Bearer ${requestOptions.token}` } : {}),
    ...requestOptions?.headers,
  });

  const context: IntegrationContext = {
    engine,
    server,
    gql: async (query, variables, requestOptions) => {
      const response = await Bun.fetch(url(prefixes.graphql), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(requestOptions) },
        body: JSON.stringify({ query, variables }),
      });

      return response.json();
    },
    rest: (path, init) =>
      Bun.fetch(url(`${prefixes.rest}${path}`), {
        ...init,
        headers: { ...authHeaders(init), ...(init?.headers as Record<string, string>) },
      }),
    sql: (statement) => raw.query(statement),
  };

  try {
    return await fn(context);
  } finally {
    await raw.close();
    server.stop(true);
    await disconnectDatabases();
  }
};

/**
 * `describe` that no-ops unless INTEGRATION=1, so the fast unit suite stays
 * runnable without Docker.
 */
export const integrationEnabled = INTEGRATION_ENABLED;

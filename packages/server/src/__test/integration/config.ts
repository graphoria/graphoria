import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConnectionForType } from "../../config";
import type { DatabaseType } from "../../types/configuration";

/** The SQLite files live here; the seed recreates their tables on every run. */
export const SQLITE_DIR = join(tmpdir(), "graphoria-integration-sqlite");

/**
 * Connection details for the containers in `docker-compose.test.yml`. Ports are
 * non-default on purpose so the stack can run next to a developer's own
 * databases — change them here and in the compose file together. SQLite needs
 * no container: its files are in SQLITE_DIR.
 */
export const CONNECTIONS = {
  pg: {
    host: "127.0.0.1",
    port: 55432,
    user: "postgres",
    password: "graphoria_test",
    database: "graphoria_test",
  },
  mysql: {
    host: "127.0.0.1",
    port: 53306,
    user: "root",
    password: "graphoria_test",
    database: "graphoria_app",
  },
  mssql: {
    host: "127.0.0.1",
    port: 51433,
    user: "sa",
    password: "Graphoria_test1",
    database: "graphoria_test",
  },
  sqlite: {
    filename: join(SQLITE_DIR, "app.db"),
    attach: { catalog: join(SQLITE_DIR, "catalog.db"), auth: join(SQLITE_DIR, "auth.db") },
  },
} as const satisfies { [T in DatabaseType]: ConnectionForType<T> };

/**
 * The container speaks caching_sha2_password over plain TCP, which needs an RSA
 * public key exchange that Bun's MySQL client refuses unless asked to allow it.
 * Applies to every MySQL connection the suite opens.
 */
export const MYSQL_CONNECTION_OPTIONS = { allowPublicKeyRetrieval: true } as const;

export const REDIS_URL = "redis://127.0.0.1:56379";

/** The server speaks AMQP to `port`; the suite reads queue state from `managementUrl`. */
export const RABBITMQ = {
  host: "127.0.0.1",
  port: 55672,
  managementUrl: "http://127.0.0.1:55673",
  username: "graphoria",
  password: "graphoria_test",
} as const;

/** The broker advertises this same address, and clients reconnect to it. */
export const KAFKA_BROKER = "localhost:59092";

/** Engines the integration suite runs against. */
export const ENGINES = ["pg", "mysql", "mssql", "sqlite"] as const;

/**
 * The suite only runs when INTEGRATION=1, so the unit suite stays fast and
 * runnable without Docker.
 */
export const INTEGRATION_ENABLED = process.env["INTEGRATION"] === "1";

/**
 * MySQL has no schema-inside-a-database concept — its "schemas" are databases.
 * The canonical schema therefore lands in two databases there and two schemas
 * everywhere else, and tests refer to the logical names through this map.
 * SQLite's main file is schema `main`; catalog is a second file attached under
 * that name.
 */
export const SCHEMAS = {
  pg: { app: "app", catalog: "catalog" },
  mysql: { app: "graphoria_app", catalog: "graphoria_catalog" },
  mssql: { app: "app", catalog: "catalog" },
  sqlite: { app: "main", catalog: "catalog" },
} as const satisfies Record<DatabaseType, { app: string; catalog: string }>;

/**
 * Root GraphQL field name for a table, following the default `{schema}_{name}`
 * field naming.
 */
export const fieldName = (engine: DatabaseType, schema: "app" | "catalog", table: string) =>
  `${SCHEMAS[engine][schema]}_${table}`;

import type { DatabaseType } from "../../types/configuration";

/**
 * Connection details for the containers in `docker-compose.test.yml`. Ports are
 * non-default on purpose so the stack can run next to a developer's own
 * databases — change them here and in the compose file together.
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
} as const satisfies Record<DatabaseType, Record<string, string | number>>;

export const REDIS_URL = "redis://127.0.0.1:56379";

/** Engines the integration suite runs against. */
export const ENGINES = ["pg", "mysql", "mssql"] as const;

/**
 * The suite only runs when INTEGRATION=1, so the unit suite stays fast and
 * runnable without Docker.
 */
export const INTEGRATION_ENABLED = process.env["INTEGRATION"] === "1";

/**
 * MySQL has no schema-inside-a-database concept — its "schemas" are databases.
 * The canonical schema therefore lands in two databases there and two schemas
 * everywhere else, and tests refer to the logical names through this map.
 */
export const SCHEMAS = {
  pg: { app: "app", catalog: "catalog" },
  mysql: { app: "graphoria_app", catalog: "graphoria_catalog" },
  mssql: { app: "app", catalog: "catalog" },
} as const satisfies Record<DatabaseType, { app: string; catalog: string }>;

/**
 * Root GraphQL field name for a table, following the default `{schema}_{name}`
 * field naming.
 */
export const fieldName = (engine: DatabaseType, schema: "app" | "catalog", table: string) =>
  `${SCHEMAS[engine][schema]}_${table}`;

/**
 * Tables whose identifiers are legal SQL but produce an illegal GraphQL name
 * under the default `{schema}_{name}` field naming, because `genResolverName`
 * does not sanitise its output. Including them makes the server fail to boot
 * with a GraphQL syntax error, so the default harness config excludes them —
 * see identifiers.test.ts, which pins the behaviour, and the note in
 * HARDENING_PROGRESS.md.
 */
export const UNSUPPORTED_IDENTIFIER_TABLES = (engine: DatabaseType) => [
  `${SCHEMAS[engine].catalog}_space name`,
  `${SCHEMAS[engine].catalog}_categoría`,
];

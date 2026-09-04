import type { DatabaseType } from "../src/types/configuration";

import { CONNECTIONS } from "../src/__test/integration/config";

/**
 * The benchmark runs against its own database on the same containers as the
 * integration suite, so `docker compose -f docker-compose.test.yml up` is the
 * only setup either needs. That keeps the 100k-row table out of an integration
 * server's introspection on PostgreSQL and SQL Server — but not on MySQL, whose
 * databases are its schemas and are all introspected. See README.md.
 */
export const BENCH_DATABASE = "graphoria_bench";

/**
 * MySQL has no schema-inside-a-database concept, so its tables live directly in
 * the bench database while the other two get a `bench` schema.
 */
export const BENCH_SCHEMAS = {
  pg: "bench",
  mysql: BENCH_DATABASE,
  mssql: "bench",
} as const satisfies Record<DatabaseType, string>;

/** Root GraphQL field for a bench table, following the default `{schema}_{name}`. */
export const benchField = (engine: DatabaseType, table: string) =>
  `${BENCH_SCHEMAS[engine]}_${table}`;

/** Qualified SQL name for a bench table. */
export const benchTable = (engine: DatabaseType, table: string) =>
  `${BENCH_SCHEMAS[engine]}.${table}`;

/**
 * Row counts. The plan asks for 100k+ in the primary table; the parent levels
 * are sized so the nested scenario has ten children per parent, the same shape
 * the N+1 audit measured.
 */
export const ROW_COUNTS = { users: 1_000, projects: 10_000, tasks: 100_000 } as const;

export const benchConnection = (engine: DatabaseType) => ({
  ...CONNECTIONS[engine],
  database: BENCH_DATABASE,
});

export const ENGINES = ["pg", "mysql", "mssql"] as const satisfies readonly DatabaseType[];

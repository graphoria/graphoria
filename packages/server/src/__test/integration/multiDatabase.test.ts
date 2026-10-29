import { Database as SQLiteDatabase } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ConfigurationInput } from "../../config";
import type { IntegrationContext, StartedServer } from "./harness";

import { CONNECTIONS, MYSQL_CONNECTION_OPTIONS, fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";

/**
 * One request that selects a root from each of two databases. Each statement
 * references only its own roots' placeholders, while the variable list is
 * request-wide; PostgreSQL rejects a bound parameter that the statement never
 * uses with 42P18, so every statement has to carry its own subset.
 *
 * The second database is a throwaway SQLite file with one table, so nothing
 * collides with the canonical schema the primary database carries. Every
 * primary engine runs the same requests because the subset is renumbered in
 * that engine's own placeholder character — `$n` for Postgres and MySQL, `@n`
 * for T-SQL — and MySQL additionally rewrites the text to `?` before binding.
 */

type PrimaryEngine = "pg" | "mysql" | "mssql";

type PrimaryDatabase = NonNullable<ConfigurationInput["databases"]>[number];

const primaryDatabase = (engine: PrimaryEngine): PrimaryDatabase => {
  switch (engine) {
    case "pg":
      return {
        name: "default",
        enabled: true,
        type: "pg",
        connection: { ...CONNECTIONS.pg },
      };
    case "mysql":
      return {
        name: "default",
        enabled: true,
        type: "mysql",
        connection: { ...CONNECTIONS.mysql },
        connectionOptions: MYSQL_CONNECTION_OPTIONS,
      };
    case "mssql":
      return {
        name: "default",
        enabled: true,
        type: "mssql",
        connection: { ...CONNECTIONS.mssql },
      };
  }
};

/** Boots a server whose request can reach `engine` and a one-table SQLite file. */
const startTwoDatabases = async (
  engine: PrimaryEngine,
  label: string,
  config: Partial<ConfigurationInput> = {},
): Promise<{ started: StartedServer; liteFile: string }> => {
  const liteFile = join(tmpdir(), `graphoria-integration-two-databases-${label}.db`);

  const lite = new SQLiteDatabase(liteFile);
  try {
    lite.run("DROP TABLE IF EXISTS authors");
    lite.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    lite.run("INSERT INTO authors (name) VALUES ('Ana'), ('Brian'), ('Cleo')");
  } finally {
    lite.close();
  }

  await seedEngine(engine);

  const started = await startServer({
    engine,
    skipSeed: true,
    config: {
      databases: [
        primaryDatabase(engine),
        { name: "lite", enabled: true, type: "sqlite", connection: { filename: liteFile } },
      ],
      ...config,
    },
  });

  return { started, liteFile };
};

const ids = (rows: { id: number }[] | undefined) =>
  (rows ?? []).map((row) => row.id).sort((a, b) => a - b);

const AUTHORS = [1, 2, 3];
const USERS = [1, 2, 3, 4, 5, 6];

for (const engine of ["pg", "mysql", "mssql"] as const) {
  describe.skipIf(!integrationEnabled)(`query · two databases · ${engine}`, () => {
    let started: StartedServer;
    let liteFile: string;
    let gql: IntegrationContext["gql"];

    // MySQL's "schemas" are databases, so the same table is reachable under a
    // different root field on each engine.
    const users = fieldName(engine, "app", "users");
    const authors = fieldName("sqlite", "app", "authors");

    beforeAll(async () => {
      const booted = await startTwoDatabases(engine, engine);
      started = booted.started;
      liteFile = booted.liteFile;
      gql = started.context.gql;
    });

    afterAll(async () => {
      await started?.stop();
      await rm(liteFile, { force: true });
    });

    it("selects a root from each database without filtering", async () => {
      const response = await gql<Record<string, { id: number }[]>>(`
        query {
          ${users} { id }
          ${authors} { id }
        }
      `);

      expect(response.errors ?? []).toEqual([]);
      expect(ids(response.data?.[users])).toEqual(USERS);
      expect(ids(response.data?.[authors])).toEqual(AUTHORS);
    });

    it("filters a root on each database, primary first", async () => {
      const response = await gql<Record<string, { id: number }[]>>(`
        query {
          ${users}(where: { email: { neq: "nobody@nowhere.test" } }) { id }
          ${authors}(where: { name: { neq: "zzz" } }) { id }
        }
      `);

      expect(response.errors ?? []).toEqual([]);
      expect(ids(response.data?.[users])).toEqual(USERS);
      expect(ids(response.data?.[authors])).toEqual(AUTHORS);
    });

    it("filters a root on each database, primary last", async () => {
      const response = await gql<Record<string, { id: number }[]>>(`
        query {
          ${authors}(where: { name: { neq: "zzz" } }) { id }
          ${users}(where: { email: { neq: "nobody@nowhere.test" } }) { id }
        }
      `);

      expect(response.errors ?? []).toEqual([]);
      expect(ids(response.data?.[users])).toEqual(USERS);
      expect(ids(response.data?.[authors])).toEqual(AUTHORS);
    });

    it("reads a single row from each database", async () => {
      const response = await gql<Record<string, { id: number }>>(`
        query {
          ${users}_single(where: { id: { eq: 1 } }) { id }
          ${authors}_single(where: { id: { eq: 2 } }) { id }
        }
      `);

      expect(response.errors ?? []).toEqual([]);
      expect(response.data?.[`${users}_single`]).toEqual({ id: 1 });
      expect(response.data?.[`${authors}_single`]).toEqual({ id: 2 });
    });

    it("paginates a root on each database with its own limit variable", async () => {
      const response = await gql<Record<string, { id: number }[]>>(
        `
        query ($primaryPageSize: Int, $litePageSize: Int) {
          ${users}(limit: $primaryPageSize) { id }
          ${authors}(limit: $litePageSize) { id }
        }
      `,
        { primaryPageSize: 2, litePageSize: 2 },
      );

      expect(response.errors ?? []).toEqual([]);
      expect(ids(response.data?.[users])).toEqual([1, 2]);
      expect(ids(response.data?.[authors])).toEqual([1, 2]);
    });
  });
}

/** The same two statements, with the row filter coming from the role instead of the query. */
describe.skipIf(!integrationEnabled)("query · two databases · permission filters", () => {
  let started: StartedServer;
  let liteFile: string;

  beforeAll(async () => {
    const booted = await startTwoDatabases("pg", "permissions", {
      auth: {
        enabled: false,
        database: "",
        permissions: {
          anonymous: {
            tables: {
              app_users: { columns: "ALL", filter: { email: { neq: "nobody@nowhere.test" } } },
              main_authors: { columns: "ALL", filter: { name: { neq: "zzz" } } },
            },
            storedProcedures: "ALL",
          },
        },
      },
    });

    started = booted.started;
    liteFile = booted.liteFile;
  });

  afterAll(async () => {
    await started?.stop();
    await rm(liteFile, { force: true });
  });

  it("applies a role filter to each database's statement", async () => {
    const response = await started.context.gql<Record<string, { id: number }[]>>(`
      query {
        app_users { id }
        main_authors { id }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(ids(response.data?.app_users)).toEqual(USERS);
    expect(ids(response.data?.main_authors)).toEqual(AUTHORS);
  });
});

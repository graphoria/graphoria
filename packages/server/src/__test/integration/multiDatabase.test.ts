import { Database as SQLiteDatabase } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { CONNECTIONS } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";

/**
 * One request that selects a root from each of two databases. Each statement
 * references only its own roots' placeholders, while the variable list is
 * request-wide; PostgreSQL rejects a bound parameter that the statement never
 * uses with 42P18, so every statement has to carry its own subset.
 *
 * The second database is a throwaway SQLite file with one table, so nothing
 * collides with the canonical schema the Postgres database carries.
 */
describe.skipIf(!integrationEnabled)("query · two databases", () => {
  const liteFile = join(tmpdir(), "graphoria-integration-multi-database.db");

  let started: StartedServer;
  let gql: IntegrationContext["gql"];

  beforeAll(async () => {
    const lite = new SQLiteDatabase(liteFile);
    try {
      lite.run("DROP TABLE IF EXISTS authors");
      lite.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      lite.run("INSERT INTO authors (name) VALUES ('Ana'), ('Brian'), ('Cleo')");
    } finally {
      lite.close();
    }

    await seedEngine("pg");

    started = await startServer({
      engine: "pg",
      skipSeed: true,
      config: {
        databases: [
          {
            name: "default",
            enabled: true,
            type: "pg",
            connection: { ...CONNECTIONS.pg },
          },
          {
            name: "lite",
            enabled: true,
            type: "sqlite",
            connection: { filename: liteFile },
          },
        ],
      },
    });

    gql = started.context.gql;
  });

  afterAll(async () => {
    await started?.stop();
    await rm(liteFile, { force: true });
  });

  const ids = (rows: { id: number }[] | undefined) =>
    (rows ?? []).map((row) => row.id).sort((a, b) => a - b);

  it("selects a root from each database without filtering", async () => {
    const response = await gql<Record<string, { id: number }[]>>(`
      query {
        app_users { id }
        main_authors { id }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(ids(response.data?.app_users)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(response.data?.main_authors)).toEqual([1, 2, 3]);
  });

  it("filters a root on each database, Postgres first", async () => {
    const response = await gql<Record<string, { id: number }[]>>(`
      query {
        app_users(where: { email: { neq: "nobody@nowhere.test" } }) { id }
        main_authors(where: { name: { neq: "zzz" } }) { id }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(ids(response.data?.app_users)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(response.data?.main_authors)).toEqual([1, 2, 3]);
  });

  it("filters a root on each database, Postgres last", async () => {
    const response = await gql<Record<string, { id: number }[]>>(`
      query {
        main_authors(where: { name: { neq: "zzz" } }) { id }
        app_users(where: { email: { neq: "nobody@nowhere.test" } }) { id }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(ids(response.data?.app_users)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(response.data?.main_authors)).toEqual([1, 2, 3]);
  });

  it("paginates a root on each database with its own limit variable", async () => {
    const response = await gql<Record<string, { id: number }[]>>(
      `
      query ($pgPageSize: Int, $litePageSize: Int) {
        app_users(limit: $pgPageSize) { id }
        main_authors(limit: $litePageSize) { id }
      }
    `,
      { pgPageSize: 2, litePageSize: 2 },
    );

    expect(response.errors ?? []).toEqual([]);
    expect(ids(response.data?.app_users)).toEqual([1, 2]);
    expect(ids(response.data?.main_authors)).toEqual([1, 2]);
  });
});

/** The same two statements, with the row filter coming from the role instead of the query. */
describe.skipIf(!integrationEnabled)("query · two databases · permission filters", () => {
  const liteFile = join(tmpdir(), "graphoria-integration-multi-database-permissions.db");

  let started: StartedServer;

  beforeAll(async () => {
    const lite = new SQLiteDatabase(liteFile);
    try {
      lite.run("DROP TABLE IF EXISTS authors");
      lite.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      lite.run("INSERT INTO authors (name) VALUES ('Ana'), ('Brian'), ('Cleo')");
    } finally {
      lite.close();
    }

    await seedEngine("pg");

    started = await startServer({
      engine: "pg",
      skipSeed: true,
      config: {
        databases: [
          {
            name: "default",
            enabled: true,
            type: "pg",
            connection: { ...CONNECTIONS.pg },
          },
          {
            name: "lite",
            enabled: true,
            type: "sqlite",
            connection: { filename: liteFile },
          },
        ],
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
      },
    });
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
    expect((response.data?.app_users ?? []).map((row) => row.id).sort()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect((response.data?.main_authors ?? []).map((row) => row.id).sort()).toEqual([1, 2, 3]);
  });
});

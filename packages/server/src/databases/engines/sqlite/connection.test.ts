import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../../types/configuration";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";

const { logger } = await import("../../../logging");
const { setQueryTimeoutMs } = await import("../../../singletons/queryTimeout");
const { databasesConnections } = await import("../../../singletons/databases");
const {
  callStoredProcedure,
  executeQuery,
  executeQueryJSON,
  getPool,
  isSupportedVersion,
  openDatabase,
  schemasOf,
} = await import("./connection");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-sqlite-connection-"));
});

afterAll(() => rm(dir, { recursive: true, force: true }));

const sqliteDb = (attach?: Record<string, string>): Database =>
  ({
    name: "sqlite_test",
    enabled: true,
    type: "sqlite",
    connection: { filename: join(dir, "main.db"), ...(attach ? { attach } : {}) },
    fieldNaming: "{schema}_{name}",
  }) as Database;

describe("isSupportedVersion", () => {
  it.each([
    ["3.44.0", true],
    ["3.53.2", true],
    ["4.0.0", true],
    ["3.44", true],
    ["3.43.2", false],
    ["2.99.99", false],
  ])("%s → %p", (version, supported) => {
    expect(isSupportedVersion(version)).toBe(supported);
  });
});

describe("openDatabase", () => {
  it("attaches every file under its schema name", () => {
    const db = sqliteDb({ catalog: join(dir, "catalog.db") });
    const connection = openDatabase(db);

    try {
      const names = connection
        .query("SELECT name FROM pragma_database_list ORDER BY seq")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(names).toEqual(["main", "catalog"]);
      expect(schemasOf(db)).toEqual(["main", "catalog"]);
    } finally {
      connection.close();
    }
  });

  it("waits for another connection's write lock instead of failing at once", () => {
    const connection = openDatabase(sqliteDb());

    try {
      expect(connection.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      connection.close();
    }
  });

  it("refuses a schema name it would have to interpolate unchecked", () => {
    expect(() => openDatabase(sqliteDb({ 'x" AS y; --': join(dir, "x.db") }))).toThrow(
      "Invalid schema",
    );
  });
});

const spyOnWarn = () => spyOn(logger("db"), "warn").mockImplementation((() => {}) as never);

describe("getPool", () => {
  let warn: ReturnType<typeof spyOnWarn>;

  beforeAll(() => {
    warn = spyOnWarn();
  });

  afterEach(() => {
    warn.mockClear();
    setQueryTimeoutMs(0);
  });

  afterAll(() => warn.mockRestore());

  it("says once that the statement timeout does not apply", async () => {
    setQueryTimeoutMs(10_000);
    const connection = await getPool(sqliteDb());
    connection.close();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      database: "sqlite_test",
      queryTimeoutMs: 10_000,
    });
  });

  it("stays quiet with the timeout off", async () => {
    const connection = await getPool(sqliteDb());
    connection.close();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("executeQuery", () => {
  // Built in beforeAll: `dir` does not exist yet while describe bodies are collected.
  let db: Database;
  const definitions = [
    { name: "x", type: "Int", required: true },
    { name: "y", type: "String", required: true },
  ];

  beforeAll(() => {
    db = sqliteDb();
    databasesConnections[db.name] = openDatabase(db);
  });

  afterAll(() => {
    (databasesConnections[db.name] as SQLiteDatabase).close();
    delete databasesConnections[db.name];
  });

  it("binds $n by name, whatever order and however often it appears", async () => {
    const rows = await executeQuery("SELECT $2 AS b, $1 AS a, $1 AS again", db, definitions, {
      x: 1,
      y: "two",
    });

    expect(rows).toEqual([{ b: "two", a: 1, again: 1 }]);
  });

  it("leaves a $n inside a string literal alone", async () => {
    const rows = await executeQuery("SELECT '$1' AS literal, $1 AS bound", db, definitions, {
      x: 7,
      y: "unused",
    });

    expect(rows).toEqual([{ literal: "$1", bound: 7 }]);
  });

  it("parses the JSON text json_object() returns", async () => {
    const result = await executeQueryJSON(
      `SELECT json_object('k', $1, 'quoted', '"q"') AS json_result`,
      db,
      definitions,
      { x: 3, y: "" },
    );

    expect(result).toEqual({ k: 3, quoted: '"q"' });
  });
});

describe("callStoredProcedure", () => {
  it("refuses, as SQLite has no procedures", async () => {
    await expect(callStoredProcedure()).rejects.toThrow("SQLite has no stored procedures");
  });
});

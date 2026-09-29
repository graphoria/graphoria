import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../../types/configuration";

import { logger } from "../../../logging";
import { databasesConnections } from "../../../singletons/databases";
import { getDatabaseStructure } from "./getStructure";
import { getViewsFromDB } from "./getViews";
import { openDatabase } from "./connection";

let dir: string;

const dbAt = (name: string, attach?: Record<string, string>): Database =>
  ({
    name: "introspection_test",
    enabled: true,
    type: "sqlite",
    connection: { filename: join(dir, name), ...(attach ? { attach } : {}) },
    fieldNaming: "{schema}_{name}",
  }) as Database;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-sqlite-structure-"));

  const seed = new SQLiteDatabase(join(dir, "main.db"), { create: true });
  seed.query("ATTACH DATABASE $file AS catalog").run({ $file: join(dir, "catalog.db") });
  seed.run(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY, code TEXT NOT NULL);
    CREATE TABLE pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE children (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL REFERENCES parents,
      pair_a INTEGER,
      pair_b INTEGER,
      price DECIMAL(12, 2),
      label VARCHAR(100),
      flag BOOLEAN,
      untyped,
      FOREIGN KEY (pair_a, pair_b) REFERENCES pairs (a, b)
    );
    CREATE VIEW child_labels AS SELECT id, label FROM children;
    CREATE TABLE catalog.things (id INTEGER PRIMARY KEY);
  `);
  seed.close();
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("sqlite getDatabaseStructure", () => {
  const structure = () =>
    getDatabaseStructure(dbAt("main.db", { catalog: join(dir, "catalog.db") }));

  it("lists the tables and views of every schema, and none of SQLite's own", async () => {
    const { tables, storedProcedures } = await structure();

    expect(tables.map((t) => `${t.schema}.${t.name}:${t.entityType}`).sort()).toEqual([
      "catalog.things:table",
      "main.child_labels:view",
      "main.children:table",
      "main.pairs:table",
      "main.parents:table",
    ]);
    expect(storedProcedures).toEqual([]);
  });

  it("reports columns in declared order, with bare lower-case types", async () => {
    const children = (await structure()).tables.find((t) => t.name === "children")!;

    expect(children.columns.map((c) => [c.name, c.dataType, c.isNullable])).toEqual([
      ["id", "integer", false],
      ["parent_id", "integer", false],
      ["pair_a", "integer", true],
      ["pair_b", "integer", true],
      ["price", "decimal", true],
      ["label", "varchar", true],
      ["flag", "boolean", true],
      ["untyped", "", true],
    ]);
  });

  it("resolves a foreign key that names only its parent to the parent's key", async () => {
    const children = (await structure()).tables.find((t) => t.name === "children")!;
    const byParent = Object.fromEntries(children.foreignKeys.map((fk) => [fk.name, fk]));

    expect(byParent["parents"]).toMatchObject({
      schema: "main",
      columns: [{ source: "parent_id", target: "id" }],
    });
    expect(byParent["pairs"]).toMatchObject({
      schema: "main",
      columns: [
        { source: "pair_a", target: "a" },
        { source: "pair_b", target: "b" },
      ],
    });
  });

  it("serves no relationship for a key whose parent has no primary key, and says so", async () => {
    const seed = new SQLiteDatabase(join(dir, "orphan.db"), { create: true });
    seed.run(`
      CREATE TABLE loose (x TEXT);
      CREATE TABLE orphan (p TEXT REFERENCES loose);
    `);
    seed.close();

    const warn = spyOn(logger("db"), "warn").mockImplementation((() => {}) as never);

    try {
      const { tables } = await getDatabaseStructure(dbAt("orphan.db"));

      expect(tables.find((t) => t.name === "orphan")!.foreignKeys).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({
        database: "introspection_test",
        foreignKey: "main.orphan(p)",
        parent: "loose",
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sqlite getDatabaseStructure, on what SQLite adds", () => {
  beforeAll(() => {
    const seed = new SQLiteDatabase(join(dir, "shapes.db"), { create: true });
    seed.run(`
      CREATE VIRTUAL TABLE notes USING fts5(body);
      CREATE TABLE text_key (code TEXT PRIMARY KEY);
      CREATE TABLE int_key (id INT PRIMARY KEY);
      CREATE TABLE no_rowid (code TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE strict_key (code TEXT PRIMARY KEY) STRICT;
      CREATE TABLE computed (
        a INTEGER,
        doubled INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL,
        label TEXT GENERATED ALWAYS AS ('#' || a) STORED
      );
    `);
    seed.close();
  });

  const structure = () => getDatabaseStructure(dbAt("shapes.db"));

  it("serves a virtual table, but not the shadow tables it keeps its data in", async () => {
    const { tables } = await structure();

    expect(tables.map((t) => `${t.name}:${t.entityType}`).sort()).toEqual([
      "computed:table",
      "int_key:table",
      "no_rowid:table",
      "notes:table",
      "strict_key:table",
      "text_key:table",
    ]);
  });

  it("serves generated columns, as the other engines do", async () => {
    const computed = (await structure()).tables.find((t) => t.name === "computed")!;

    expect(computed.columns.map((c) => c.name)).toEqual(["a", "doubled", "label"]);
  });

  // INT is not INTEGER: only a column declared INTEGER PRIMARY KEY is the rowid.
  it("types a primary key nullable where SQLite stores NULL in it", async () => {
    const { tables } = await structure();
    const keyIsNullable = (table: string) =>
      tables.find((t) => t.name === table)!.columns[0]!.isNullable;

    expect(keyIsNullable("text_key")).toBe(true);
    expect(keyIsNullable("int_key")).toBe(true);
    expect(keyIsNullable("no_rowid")).toBe(false);
    expect(keyIsNullable("strict_key")).toBe(false);
  });
});

describe("sqlite getViewsFromDB", () => {
  it("returns each view with its definition", async () => {
    expect(await getViewsFromDB(dbAt("main.db", { catalog: join(dir, "catalog.db") }))).toEqual([
      {
        schema: "main",
        name: "child_labels",
        definition: "CREATE VIEW child_labels AS SELECT id, label FROM children",
      },
    ]);
  });
});

describe("introspection of a :memory: database registered on the server", () => {
  const memoryDb: Database = {
    name: "introspection_memory_test",
    enabled: true,
    type: "sqlite",
    connection: { filename: ":memory:" },
    fieldNaming: "{schema}_{name}",
  } as Database;

  beforeAll(() => {
    const connection = openDatabase(memoryDb);
    connection.run(`
      CREATE TABLE widgets (id INTEGER PRIMARY KEY);
      CREATE VIEW widget_ids AS SELECT id FROM widgets;
    `);
    databasesConnections[memoryDb.name] = connection;
  });

  afterAll(() => {
    (databasesConnections[memoryDb.name] as SQLiteDatabase).close();
    delete databasesConnections[memoryDb.name];
  });

  it("getDatabaseStructure reports a table created on the live connection, not a fresh empty database", async () => {
    const { tables } = await getDatabaseStructure(memoryDb);

    expect(tables.map((t) => `${t.schema}.${t.name}:${t.entityType}`).sort()).toEqual([
      "main.widget_ids:view",
      "main.widgets:table",
    ]);
  });

  it("getViewsFromDB reports a view created on the live connection", async () => {
    expect(await getViewsFromDB(memoryDb)).toEqual([
      {
        schema: "main",
        name: "widget_ids",
        definition: "CREATE VIEW widget_ids AS SELECT id FROM widgets",
      },
    ]);
  });
});

import { describe, expect, it } from "bun:test";

import type { DatabaseConfig } from "../../config";

import { DatabaseConnectionZod, TableColumnZod } from "./db";
import { TableRelationshipZod } from "../../config/types/db";

describe("TableColumnZod", () => {
  it("defaults description to null when absent", () => {
    const col = TableColumnZod.parse({
      name: "id",
      dataType: "int",
      isNullable: false,
    });
    expect(col.description).toBeNull();
  });

  it("exposes a column GraphQL cannot spell under a sanitised fieldName", () => {
    const col = TableColumnZod.parse({
      name: "descripción",
      dataType: "text",
      isNullable: true,
    });
    expect(col.name).toBe("descripción");
    expect(col.fieldName).toBe("descripcion");
  });

  it("leaves fieldName equal to name for a legal column", () => {
    const col = TableColumnZod.parse({ name: "id", dataType: "int", isNullable: false });
    expect(col.fieldName).toBe("id");
  });

  it("preserves a database-provided description", () => {
    const col = TableColumnZod.parse({
      name: "id",
      dataType: "int",
      isNullable: false,
      description: "primary key",
    });
    expect(col.description).toBe("primary key");
  });
});

describe("DatabaseConnectionZod schema overrides", () => {
  const base = {
    name: "main",
    enabled: true,
    type: "pg" as const,
    connection: {
      host: "localhost",
      port: 5432,
      user: "u",
      password: "p",
      database: "db",
    },
  };

  it("accepts description and columnDescriptions per table", () => {
    const parsed = DatabaseConnectionZod.parse({
      ...base,
      schema: {
        database: {
          public_users: {
            description: "Application users",
            columnDescriptions: { id: "primary key", email: "login email" },
          },
        },
      },
    });

    const override = parsed.schema!.database.public_users;
    expect(override.description).toBe("Application users");
    expect(override.columnDescriptions).toEqual({
      id: "primary key",
      email: "login email",
    });
  });

  it("defaults columnDescriptions to an empty object", () => {
    const parsed = DatabaseConnectionZod.parse({
      ...base,
      schema: { database: { public_users: {} } },
    });

    expect(parsed.schema!.database.public_users.columnDescriptions).toEqual({});
    expect(parsed.schema!.database.public_users.description).toBeUndefined();
  });

  it("retains an onConnect handler through parse", () => {
    const onConnect = () => {};
    const parsed = DatabaseConnectionZod.parse({ ...base, onConnect });
    expect(parsed.onConnect).toBe(onConnect);
  });
});

// Asserted against TableRelationshipZod rather than through DatabaseConnectionZod:
// DatabaseSchemaConfigZod.database applies `.catch(...)` per table override, which
// swallows any validation error inside one and substitutes empty defaults.
describe("TableRelationshipZod ancestor operand", () => {
  const ancestor = { schema: "public", name: "a", column: "third_col" };

  const rel = (condition: unknown) => ({
    schema: "public",
    name: "c",
    columns: [{ source: "second_col", target: "second_col" }],
    conditions: [condition],
  });

  it("accepts an ancestor in place of a value and defaults the operator", () => {
    const parsed = TableRelationshipZod.parse(rel({ target: "third_col", ancestor }));
    expect(parsed.conditions![0]).toEqual({ target: "third_col", operator: "eq", ancestor });
  });

  it("rejects a condition carrying both a value and an ancestor", () => {
    expect(() =>
      TableRelationshipZod.parse(rel({ target: "third_col", value: "x", ancestor })),
    ).toThrow();
  });

  it("rejects a condition carrying neither a value nor an ancestor", () => {
    expect(() => TableRelationshipZod.parse(rel({ target: "third_col" }))).toThrow();
  });

  it("rejects an ancestor on a null-check operator, which would silently ignore it", () => {
    expect(() =>
      TableRelationshipZod.parse(rel({ target: "third_col", operator: "is_null", ancestor })),
    ).toThrow();
  });

  it("still accepts a null-check operator with no operand", () => {
    const parsed = TableRelationshipZod.parse(rel({ target: "third_col", operator: "is_null" }));
    expect(parsed.conditions![0]).toEqual({ target: "third_col", operator: "is_null" });
  });

  it("rejects an ancestor missing a column", () => {
    expect(() =>
      TableRelationshipZod.parse(
        rel({ target: "third_col", ancestor: { schema: "public", name: "a" } }),
      ),
    ).toThrow();
  });
});

describe("DatabaseConnectionZod sqlite", () => {
  const sqlite = {
    name: "local",
    enabled: true,
    type: "sqlite" as const,
    connection: { filename: "app.db" },
  };

  const paths = (input: unknown) => {
    const result = DatabaseConnectionZod.safeParse(input);
    if (result.success) throw new Error("expected parse to fail");
    return result.error.issues.map((issue) => issue.path.join("."));
  };

  it("accepts a main file and the files it attaches", () => {
    const parsed = DatabaseConnectionZod.parse({
      ...sqlite,
      connection: { filename: "app.db", attach: { catalog: "catalog.db" } },
    });

    expect(parsed.type).toBe("sqlite");
    expect(parsed.connection).toEqual({ filename: "app.db", attach: { catalog: "catalog.db" } });
  });

  it("rejects a server connection on a sqlite database", () => {
    expect(
      paths({
        ...sqlite,
        connection: { host: "h", port: 1, user: "u", password: "p", database: "d" },
      }),
    ).toContain("connection.filename");
  });

  it("rejects a file connection on a server engine", () => {
    expect(paths({ ...sqlite, type: "pg" })).toContain("connection.host");
  });

  it("rejects connectionOptions, which SQLite has nothing to apply to", () => {
    expect(paths({ ...sqlite, connectionOptions: { max: 2 } })).toEqual(["connectionOptions"]);
  });

  it.each(["main", "TEMP", "bad name", "1st"])("rejects %p as an attached schema", (name) => {
    const result = DatabaseConnectionZod.safeParse({
      ...sqlite,
      connection: { filename: "app.db", attach: { [name]: "x.db" } },
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({ path: ["connection", "attach", name] });
    expect(result.error!.issues[0]!.message).toContain("is not a schema name SQLite can attach");
  });

  // Compile-time: `run` exists on bun:sqlite's Database only, so type-check
  // fails if onConnect's connection is not narrowed by `type: "sqlite"`.
  it("types onConnect's connection as a bun:sqlite Database", () => {
    const config: DatabaseConfig<"sqlite"> = {
      name: "local",
      enabled: true,
      type: "sqlite",
      connection: { filename: ":memory:" },
      onConnect: (connection) => {
        connection.run("SELECT 1");
      },
    };

    expect(config.connection).toEqual({ filename: ":memory:" });
  });
});

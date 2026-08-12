import { describe, expect, it } from "bun:test";

import { DatabaseConnectionZod, TableColumnZod } from "./db";

describe("TableColumnZod", () => {
  it("defaults description to null when absent", () => {
    const col = TableColumnZod.parse({
      name: "id",
      dataType: "int",
      isNullable: false,
    });
    expect(col.description).toBeNull();
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

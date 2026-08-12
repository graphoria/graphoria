import { describe, expect, it } from "bun:test";

import { generateSchemaCreationMSSQL, generateSchemaCreationPostgreSQL } from ".";
import { format as formatMSSQL } from "../../engines/mssql/format";
import { format as formatPostgreSQL } from "../../engines/postgresql/format";

describe("generateSchemaCreation: MSSQL", () => {
  it("without if exist clauses", () => {
    expect(formatMSSQL(generateSchemaCreationMSSQL("foo", false))).toEqual(
      formatMSSQL("CREATE SCHEMA foo;"),
    );
  });

  it("without schema with if exist clause on table", () => {
    expect(formatMSSQL(generateSchemaCreationMSSQL("foo", true))).toEqual(
      formatMSSQL(`
        IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'foo')
          EXEC('CREATE SCHEMA [foo]');
      `),
    );
  });
});

describe("generateSchemaCreation: PostgreSQL", () => {
  it("without if exist clauses", () => {
    expect(formatPostgreSQL(generateSchemaCreationPostgreSQL("foo", false))).toEqual(
      formatPostgreSQL('CREATE SCHEMA "foo";'),
    );
  });

  it("without schema with if exist clause on table", () => {
    expect(formatPostgreSQL(generateSchemaCreationPostgreSQL("foo", true))).toEqual(
      formatPostgreSQL('CREATE SCHEMA IF NOT EXISTS "foo";'),
    );
  });
});

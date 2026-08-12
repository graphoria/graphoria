import { describe, expect, it } from "bun:test";

import { generateCreateTableMSSQL, generateCreateTablePostgreSQL } from ".";
import { dbMSSQL, dbPostgreSQL } from "../../../__test/dbMocks";
import { enrichTable } from "../../../types/zod/db";
import { format as formatMSSQL } from "../../engines/mssql/format";
import { format as formatPostgreSQL } from "../../engines/postgresql/format";
import { buildTableResolver } from "../../transformers/data-transformers";

const testTableRaw = enrichTable({
  schema: "dbo",
  name: "pbcatfmt",
  columns: [
    { name: "pbf_name", dataType: "varchar", isNullable: false, description: null },
    { name: "pbf_frmt", dataType: "varchar", isNullable: false, description: null },
    { name: "pbf_type", dataType: "smallint", isNullable: false, description: null },
    { name: "pbf_cntr", dataType: "int", isNullable: false, description: null },
  ],
  entityType: "table",
  foreignKeys: [],
});

const testTableMSSQL = buildTableResolver([testTableRaw], testTableRaw, dbMSSQL);
const testTablePG = buildTableResolver([testTableRaw], testTableRaw, dbPostgreSQL);

describe("generateCreateTableSQL: MSSQL", () => {
  it("without if exist clauses", () => {
    expect(
      formatMSSQL(
        generateCreateTableMSSQL(testTableMSSQL, {
          schemaCreation: false,
          schemaCreationIfExists: false,
          tableCreationIfExists: false,
        }),
      ),
    ).toEqual(
      formatMSSQL(`
        CREATE TABLE dbo.pbcatfmt (
          pbf_name VARCHAR(MAX),
          pbf_frmt VARCHAR(MAX),
          pbf_type SMALLINT,
          pbf_cntr INT
        );
      `),
    );
  });

  it("without schema with if exist clause on table", () => {
    expect(
      formatMSSQL(
        generateCreateTableMSSQL(testTableMSSQL, {
          schemaCreation: false,
          schemaCreationIfExists: false,
          tableCreationIfExists: true,
        }),
      ),
    ).toEqual(
      formatMSSQL(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE object_id = OBJECT_ID('dbo.pbcatfmt'))
          CREATE TABLE dbo.pbcatfmt (
            pbf_name VARCHAR(MAX),
            pbf_frmt VARCHAR(MAX),
            pbf_type SMALLINT,
            pbf_cntr INT
          );
      `),
    );
  });

  it("with schema creation, without exist clauses", () => {
    expect(
      formatMSSQL(
        generateCreateTableMSSQL(testTableMSSQL, {
          schemaCreation: true,
          schemaCreationIfExists: false,
          tableCreationIfExists: false,
        }),
      ),
    ).toEqual(
      formatMSSQL(`
        CREATE SCHEMA dbo;

        CREATE TABLE dbo.pbcatfmt (
          pbf_name VARCHAR(MAX),
          pbf_frmt VARCHAR(MAX),
          pbf_type SMALLINT,
          pbf_cntr INT
        );
      `),
    );
  });

  it("with schema creation and with if exist clause on table and schema", () => {
    expect(
      formatMSSQL(
        generateCreateTableMSSQL(testTableMSSQL, {
          schemaCreation: true,
          schemaCreationIfExists: true,
          tableCreationIfExists: true,
        }),
      ),
    ).toEqual(
      formatMSSQL(`
        IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'dbo')
          EXEC('CREATE SCHEMA [dbo]');

        IF NOT EXISTS (SELECT * FROM sys.tables WHERE object_id = OBJECT_ID('dbo.pbcatfmt'))
          CREATE TABLE dbo.pbcatfmt (
            pbf_name VARCHAR(MAX),
            pbf_frmt VARCHAR(MAX),
            pbf_type SMALLINT,
            pbf_cntr INT
          );
      `),
    );
  });
});

describe("generateCreateTableSQL: PostgreSQL", () => {
  it("without if exist clauses", () => {
    expect(
      formatPostgreSQL(
        generateCreateTablePostgreSQL(testTablePG, {
          schemaCreation: false,
          schemaCreationIfExists: false,
          tableCreationIfExists: false,
        }),
      ),
    ).toEqual(
      formatPostgreSQL(`
        CREATE TABLE "dbo"."pbcatfmt" (
          "pbf_name" VARCHAR NOT NULL,
          "pbf_frmt" VARCHAR NOT NULL,
          "pbf_type" SMALLINT NOT NULL,
          "pbf_cntr" INTEGER NOT NULL
        );
      `),
    );
  });

  it("without schema with if exist clause on table", () => {
    expect(
      formatPostgreSQL(
        generateCreateTablePostgreSQL(testTablePG, {
          schemaCreation: false,
          schemaCreationIfExists: false,
          tableCreationIfExists: true,
        }),
      ),
    ).toEqual(
      formatPostgreSQL(`
        CREATE TABLE IF NOT EXISTS "dbo"."pbcatfmt" (
          "pbf_name" VARCHAR NOT NULL,
          "pbf_frmt" VARCHAR NOT NULL,
          "pbf_type" SMALLINT NOT NULL,
          "pbf_cntr" INTEGER NOT NULL
        );
      `),
    );
  });

  it("with schema creation, without exist clauses", () => {
    expect(
      formatPostgreSQL(
        generateCreateTablePostgreSQL(testTablePG, {
          schemaCreation: true,
          schemaCreationIfExists: false,
          tableCreationIfExists: false,
        }),
      ),
    ).toEqual(
      formatPostgreSQL(`
        CREATE SCHEMA "dbo";
        
        CREATE TABLE "dbo"."pbcatfmt" (
          "pbf_name" VARCHAR NOT NULL,
          "pbf_frmt" VARCHAR NOT NULL,
          "pbf_type" SMALLINT NOT NULL,
          "pbf_cntr" INTEGER NOT NULL
        );
      `),
    );
  });

  it("with schema creation and with if exist clause on table and schema", () => {
    expect(
      formatPostgreSQL(
        generateCreateTablePostgreSQL(testTablePG, {
          schemaCreation: true,
          schemaCreationIfExists: true,
          tableCreationIfExists: true,
        }),
      ),
    ).toEqual(
      formatPostgreSQL(`
        CREATE SCHEMA IF NOT EXISTS "dbo";
        
        CREATE TABLE IF NOT EXISTS "dbo"."pbcatfmt" (
          "pbf_name" VARCHAR NOT NULL,
          "pbf_frmt" VARCHAR NOT NULL,
          "pbf_type" SMALLINT NOT NULL,
          "pbf_cntr" INTEGER NOT NULL
        );
      `),
    );
  });
});

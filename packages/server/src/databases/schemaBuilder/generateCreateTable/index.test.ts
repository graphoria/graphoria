import { describe, expect, it } from "bun:test";

import { generateCreateTableMSSQL, generateCreateTablePostgreSQL } from ".";
import { dbMSSQL, dbPostgreSQL } from "../../../__test/dbMocks";
import { structure } from "../../../__test/dataset/store";
import { format as formatMSSQL } from "../../engines/mssql/format";
import { format as formatPostgreSQL } from "../../engines/postgresql/format";
import { buildTableResolver } from "../../transformers/data-transformers";

const testTableRaw = structure.tables.find((t) => t.name === "categories")!;

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
        CREATE TABLE dbo.categories (
          category_id INT,
          name NVARCHAR(MAX),
          slug NVARCHAR(MAX),
          parent_category_id INT
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
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE object_id = OBJECT_ID('dbo.categories'))
          CREATE TABLE dbo.categories (
            category_id INT,
            name NVARCHAR(MAX),
            slug NVARCHAR(MAX),
            parent_category_id INT
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

        CREATE TABLE dbo.categories (
          category_id INT,
          name NVARCHAR(MAX),
          slug NVARCHAR(MAX),
          parent_category_id INT
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

        IF NOT EXISTS (SELECT * FROM sys.tables WHERE object_id = OBJECT_ID('dbo.categories'))
          CREATE TABLE dbo.categories (
            category_id INT,
            name NVARCHAR(MAX),
            slug NVARCHAR(MAX),
            parent_category_id INT
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
        CREATE TABLE "dbo"."categories" (
          "category_id" INTEGER NOT NULL,
          "name" VARCHAR NOT NULL,
          "slug" VARCHAR NOT NULL,
          "parent_category_id" INTEGER NULL
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
        CREATE TABLE IF NOT EXISTS "dbo"."categories" (
          "category_id" INTEGER NOT NULL,
          "name" VARCHAR NOT NULL,
          "slug" VARCHAR NOT NULL,
          "parent_category_id" INTEGER NULL
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
        
        CREATE TABLE "dbo"."categories" (
          "category_id" INTEGER NOT NULL,
          "name" VARCHAR NOT NULL,
          "slug" VARCHAR NOT NULL,
          "parent_category_id" INTEGER NULL
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
        
        CREATE TABLE IF NOT EXISTS "dbo"."categories" (
          "category_id" INTEGER NOT NULL,
          "name" VARCHAR NOT NULL,
          "slug" VARCHAR NOT NULL,
          "parent_category_id" INTEGER NULL
        );
      `),
    );
  });
});

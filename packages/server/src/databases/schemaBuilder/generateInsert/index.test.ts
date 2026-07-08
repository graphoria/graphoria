import { describe, expect, it } from "bun:test";

import { generateInsertSQLMSSQL, generateInsertSQLPostgreSQL } from ".";
import { buildTableResolver } from "../..";
import { dbMSSQL, dbPostgreSQL } from "../../../__test/dbMocks";
import { enrichTable } from "../../../types/zod/db";
import { format as formatMSSQL } from "../../engines/mssql/format";
import { format as formatPostgreSQL } from "../../engines/postgresql/format";

const categoriesTable = enrichTable({
  schema: "dbo",
  name: "categories",
  columns: [
    { name: "category_id", dataType: "int", isNullable: false, description: null },
    { name: "name", dataType: "nvarchar", isNullable: false, description: null },
    { name: "slug", dataType: "nvarchar", isNullable: false, description: null },
    { name: "parent_category_id", dataType: "int", isNullable: true, description: null },
  ],
  entityType: "table",
  foreignKeys: [],
});

const testTableMSSQL = buildTableResolver([], categoriesTable, dbMSSQL);
const testTablePG = buildTableResolver([], categoriesTable, dbPostgreSQL);

const testData = [
  {
    category_id: 1,
    name: "Electronics",
    slug: "electronics",
    parent_category_id: 0,
  },
  {
    category_id: 2,
    name: "Laptops",
    slug: "laptops",
    parent_category_id: 1,
  },
];

describe("generateInsertSQL: MSSQL", () => {
  it("generates correct insert statement and values", () => {
    const sql = generateInsertSQLMSSQL(testTableMSSQL, testData);

    expect(formatMSSQL(sql)).toEqual(
      formatMSSQL(`
        INSERT INTO dbo.categories (category_id,name,slug,parent_category_id) VALUES
        (1,N'Electronics',N'electronics',0),
        (2,N'Laptops',N'laptops',1)
      `),
    );
  });
});

describe("generateInsertSQL: PostgreSQL", () => {
  it("generates correct insert statement and values", () => {
    const sql = generateInsertSQLPostgreSQL(testTablePG, testData);

    expect(formatPostgreSQL(sql)).toEqual(
      formatPostgreSQL(`
        INSERT INTO "dbo"."categories" ("category_id","name","slug","parent_category_id") VALUES
        (1,'Electronics','electronics',0),
        (2,'Laptops','laptops',1)
      `),
    );
  });
});

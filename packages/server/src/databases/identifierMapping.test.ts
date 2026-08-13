import { describe, expect, it } from "bun:test";

import { analyzeQuery } from "../analyzeQuery";
import { createMockMSSQL, createMockMySQL, createMockPG } from "../__test/common";
import { DatabaseStructureZod } from "../types/zod/db";
import { genSql as genSqlMSSQL } from "./engines/mssql/format";
import { genSql as genSqlMySQL } from "./engines/mysql/format";
import { genSql as genSqlPG } from "./engines/postgresql/format";

// A table and columns every engine accepts and GraphQL cannot spell. The GraphQL
// document can only name the sanitised fields, so every SQL identifier emitted
// for them has to be mapped back to the real one.
const structure = DatabaseStructureZod.parse({
  tables: [
    {
      schema: "catalog",
      name: "space name",
      entityType: "table",
      columns: [
        { name: "id", dataType: "int", isNullable: false },
        { name: "space col", dataType: "nvarchar", isNullable: true },
        { name: "descripción", dataType: "nvarchar", isNullable: true },
        { name: "cantidad total", dataType: "int", isNullable: true },
      ],
      foreignKeys: [],
    },
  ],
});

const engines = [
  { name: "PostgreSQL", entities: createMockPG(structure), genSql: genSqlPG },
  { name: "MySQL", entities: createMockMySQL(structure), genSql: genSqlMySQL },
  { name: "SQL Server", entities: createMockMSSQL(structure), genSql: genSqlMSSQL },
];

for (const { name, entities, genSql } of engines) {
  describe(`${name}: identifiers GraphQL cannot spell`, () => {
    const gen = (query: string, variables: Record<string, unknown> = {}) =>
      genSql(entities, analyzeQuery(query, entities, entities.schema), variables);

    it("selects the real column and returns it under the sanitised field name", () => {
      const sql = gen(`
      {
        catalog_space_name {
          space_col
          descripcion
        }
      }
    `);

      expect(sql).toContain("space col");
      expect(sql).toContain("descripción");
      // The JSON key is the sanitised field name, whatever the engine quotes it with.
      expect(sql).toContain("space_col");
      expect(sql).toContain("descripcion");
    });

    it("filters on the real column", () => {
      const sql = gen(`
      query withFilter($value: String) {
        catalog_space_name(where: { descripcion: { eq: $value } }) {
          id
        }
      }
    `);

      expect(sql).toContain("WHERE");
      expect(sql).toContain("descripción");
    });

    it("orders by the real column", () => {
      const sql = gen(`
      {
        catalog_space_name(orderBy: [{ space_col: ASC }]) {
          id
        }
      }
    `);

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("space col");
    });

    it("groups and aggregates on the real columns", () => {
      const sql = gen(`
      {
        catalog_space_name_aggregate(groupBy: [space_col]) {
          count
          key {
            space_col
          }
          sum {
            cantidad_total
          }
          items {
            descripcion
          }
        }
      }
    `);

      expect(sql).toContain("space col");
      expect(sql).toContain("cantidad total");
      expect(sql).toContain("descripción");
      expect(sql).toContain("descripcion");
    });
  });
}

import { describe, expect, test as it } from "bun:test";

import {
  generateAggregationTypes,
  generateOrderByInputType,
  generateQueryType,
  generateTableType,
  generateTypeDefs,
  generateWhereInputType,
  mapSQLTypeToConditionType,
  mapSQLTypeToGraphQLType,
} from ".";
import { createMockMSSQL } from "../../../__test/common";
import { StoreMSSQL } from "../../../__test/dataset/store";
import { DatabaseStructureZod } from "../../../types/zod/db";

describe("Type definition generator", () => {
  describe("SQL to GraphQL type mapping", () => {
    it("should map SQL types to GraphQL types correctly", () => {
      expect(mapSQLTypeToGraphQLType("int")).toBe("Int");
      expect(mapSQLTypeToGraphQLType("varchar")).toBe("String");
      expect(mapSQLTypeToGraphQLType("bit")).toBe("Boolean");
      expect(mapSQLTypeToGraphQLType("float")).toBe("Float");
      expect(mapSQLTypeToGraphQLType("unknown")).toBe("String");
    });

    // PostgreSQL reports every DECIMAL(p, s) column as `numeric`, so typing it
    // Int published a schema that disagreed with the value the query returned.
    it("should map numeric and decimal to Float", () => {
      expect(mapSQLTypeToGraphQLType("numeric")).toBe("Float");
      expect(mapSQLTypeToGraphQLType("decimal")).toBe("Float");
      expect(mapSQLTypeToConditionType("numeric")).toBe("FloatCondition");
      expect(mapSQLTypeToConditionType("decimal")).toBe("FloatCondition");
    });

    it("should map SQL types to condition types correctly", () => {
      expect(mapSQLTypeToConditionType("int")).toBe("IntCondition");
      expect(mapSQLTypeToConditionType("varchar")).toBe("StringCondition");
      expect(mapSQLTypeToConditionType("bit")).toBe("BooleanCondition");
      expect(mapSQLTypeToConditionType("float")).toBe("FloatCondition");
      expect(mapSQLTypeToConditionType("unknown")).toBe("StringCondition");
    });
  });

  describe("Aggregation type generation", () => {
    // An average is fractional whatever the column is, so typing the Avg block
    // from the column's own type published `avg { quantity }` as Int while the
    // query returned 3.57.
    it("types every avg field Float and leaves min/max on the column type", () => {
      const result = generateAggregationTypes(StoreMSSQL);

      expect(result).toContain("type dbo_order_itemsAvg");
      expect(result.split("type dbo_order_itemsAvg")[1]?.split("}")[0]).toContain(
        "quantity: Float",
      );
      expect(result.split("type dbo_order_itemsMin")[1]?.split("}")[0]).toContain("quantity: Int");
      expect(result.split("type dbo_order_itemsMax")[1]?.split("}")[0]).toContain("quantity: Int");
      expect(result.split("type dbo_order_itemsSum")[1]?.split("}")[0]).toContain("quantity: Int");
    });
  });

  describe("Table type generation", () => {
    it("should generate correct table types with relationships", () => {
      const result = generateTableType(StoreMSSQL);
      expect(result).toContain("type dbo_products");
      expect(result).toContain("product_id: Int");
      expect(result).toContain("name: String");
      expect(result).toContain(
        "dbo_order_items(where: dbo_order_itemsWhereInput, orderBy: [dbo_order_itemsOrderByInput], limit: Int, offset: Int): [dbo_order_items]",
      );
    });

    // Without these a nested to-many list could not be paged at all: the
    // builder has always emitted the clause, but the args were never declared.
    it("declares limit and offset on to-many relationship fields", () => {
      const result = generateTableType(StoreMSSQL);
      expect(result).toMatch(/dbo_order_items\([^)]*limit: Int, offset: Int\)/);
    });
  });

  describe("Table type descriptions", () => {
    const withDescriptions = {
      tables: [
        {
          resolverName: "dbo_users",
          tableDescription: "Application users",
          columns: [
            {
              name: "id",
              dataType: "int",
              isNullable: false,
              description: "primary key",
            },
            {
              name: "name",
              dataType: "varchar",
              isNullable: true,
              description: null,
            },
          ],
          relationships: [],
          relationshipsReversed: [],
        },
      ],
    } as unknown as Parameters<typeof generateTableType>[0];

    it("emits SDL block-string descriptions for table and described columns", () => {
      const result = generateTableType(withDescriptions);
      expect(result).toContain('"""Application users"""');
      expect(result).toContain('"""primary key"""');
      expect(result).toContain("id: Int!");
    });

    it("omits descriptions for columns and tables without one", () => {
      const result = generateTableType(StoreMSSQL);
      expect(result).not.toContain('""""""');
    });
  });

  describe("Where input type generation", () => {
    it("should generate correct where input types", () => {
      const result = generateWhereInputType(StoreMSSQL);
      expect(result).toContain("input dbo_productsWhereInput");
      expect(result).toContain("product_id: IntCondition");
      expect(result).toContain("name: StringCondition");
      expect(result).toContain("dbo_order_items: dbo_order_itemsWhereInput");
    });
  });

  describe("Order by input type generation", () => {
    it("should generate correct order by input types", () => {
      const result = generateOrderByInputType(StoreMSSQL);
      expect(result).toContain("input dbo_productsOrderByInput");
      expect(result).toContain("product_id: OrderByEnum");
      expect(result).toContain("name: OrderByEnum");
    });
  });

  describe("Query type generation", () => {
    it("should generate correct query types", () => {
      const result = generateQueryType(StoreMSSQL);
      expect(result).toContain("type Query");
      expect(result).toContain(
        "dbo_products(where: dbo_productsWhereInput, orderBy: [dbo_productsOrderByInput], limit: Int, offset: Int): [dbo_products!]!",
      );
    });
  });

  describe("Complete type definitions", () => {
    it("should generate complete type definitions", () => {
      const result = generateTypeDefs(StoreMSSQL);
      expect(result).toContain("enum OrderByEnum");
      expect(result).toContain("input IntCondition");
      expect(result).toContain("input StringCondition");
      expect(result).toContain("type dbo_products");
      expect(result).toContain("type Query");
    });
  });

  // Table and column names legal in PostgreSQL, MySQL and SQL Server but not in
  // GraphQL used to produce an SDL document that failed to parse, taking the
  // whole server down at boot. createMockMSSQL runs buildSchema, so every
  // assertion below also proves the document parses.
  describe("Identifiers GraphQL cannot spell", () => {
    const hostile = () =>
      createMockMSSQL(
        DatabaseStructureZod.parse({
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
        }),
      );

    it("exposes the table and its columns under sanitised names", () => {
      const result = generateTableType(hostile());
      expect(result).toContain("type catalog_space_name");
      expect(result).toContain("space_col: String");
      expect(result).toContain("descripcion: String");
    });

    it("sanitises column names in the where and orderBy inputs", () => {
      const entities = hostile();
      expect(generateWhereInputType(entities)).toContain("descripcion: StringCondition");
      expect(generateOrderByInputType(entities)).toContain("space_col: OrderByEnum");
    });

    it("sanitises column names in the aggregate types and the groupBy enum", () => {
      const result = generateAggregationTypes(hostile());
      expect(result.split("type catalog_space_nameMin")[1]?.split("}")[0]).toContain(
        "cantidad_total: Int",
      );
      expect(result.split("enum catalog_space_nameGroupByKeys")[1]?.split("}")[0]).toContain(
        "descripcion",
      );
    });
  });
});

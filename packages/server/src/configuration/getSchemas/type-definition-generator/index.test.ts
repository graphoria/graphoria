import { describe, expect, test as it } from "bun:test";

import {
  generateOrderByInputType,
  generateQueryType,
  generateTableType,
  generateTypeDefs,
  generateWhereInputType,
  mapSQLTypeToConditionType,
  mapSQLTypeToGraphQLType,
} from ".";
import { StoreMSSQL } from "../../../__test/dataset/store";

describe("Type definition generator", () => {
  describe("SQL to GraphQL type mapping", () => {
    it("should map SQL types to GraphQL types correctly", () => {
      expect(mapSQLTypeToGraphQLType("int")).toBe("Int");
      expect(mapSQLTypeToGraphQLType("varchar")).toBe("String");
      expect(mapSQLTypeToGraphQLType("bit")).toBe("Boolean");
      expect(mapSQLTypeToGraphQLType("float")).toBe("Float");
      expect(mapSQLTypeToGraphQLType("unknown")).toBe("String");
    });

    it("should map SQL types to condition types correctly", () => {
      expect(mapSQLTypeToConditionType("int")).toBe("IntCondition");
      expect(mapSQLTypeToConditionType("varchar")).toBe("StringCondition");
      expect(mapSQLTypeToConditionType("bit")).toBe("BooleanCondition");
      expect(mapSQLTypeToConditionType("float")).toBe("FloatCondition");
      expect(mapSQLTypeToConditionType("unknown")).toBe("StringCondition");
    });
  });

  describe("Table type generation", () => {
    it("should generate correct table types with relationships", () => {
      const result = generateTableType(StoreMSSQL);
      expect(result).toContain("type dbo_products");
      expect(result).toContain("product_id: Int");
      expect(result).toContain("name: String");
      expect(result).toContain(
        "dbo_order_items(where: dbo_order_itemsWhereInput, orderBy: [dbo_order_itemsOrderByInput]): [dbo_order_items]",
      );
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
});

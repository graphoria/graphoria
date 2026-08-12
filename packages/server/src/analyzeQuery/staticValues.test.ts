import { describe, expect, it } from "bun:test";

import { StoreMSSQL } from "../__test/dataset/store";
import { analyzeQuery } from "./index";

describe("Static Value Extraction", () => {
  it("Should extract static integer value from where clause", () => {
    const query = `
      {
        dbo_orders(where: { order_id: { eq: 1 } }) {
          order_id
          customer_id
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 1,
      },
    ]);
  });

  it("Should extract static string value from where clause", () => {
    const query = `
      {
        dbo_products(where: { name: { eq: "Running Shoes" } }) {
          product_id
          name
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "String",
        required: false,
        defaultValue: "Running Shoes",
      },
    ]);
  });

  it("Should extract multiple static values in order", () => {
    const query = `
      {
        dbo_products(where: { 
          price: { gte: 100, lte: 500 }
        }) {
          product_id
          name
          price
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 100,
      },
      {
        name: "static_1",
        type: "Int",
        required: false,
        defaultValue: 500,
      },
    ]);
  });

  it("Should extract nested static values in order", () => {
    const query = `
      {
        dbo_orders(where: { order_id: { eq: 5 } }) {
          order_id
          dbo_order_items(where: { quantity: { gt: 2 } }) {
            quantity
          }
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 5,
      },
      {
        name: "static_1",
        type: "Int",
        required: false,
        defaultValue: 2,
      },
    ]);
  });

  it("Should extract boolean static values", () => {
    const query = `
      {
        dbo_products(where: { is_active: { eq: true } }) {
          product_id
          name
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Boolean",
        required: false,
        defaultValue: true,
      },
    ]);
  });

  it("Should extract float static values", () => {
    const query = `
      {
        dbo_products(where: { price: { eq: 99.99 } }) {
          product_id
          price
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Float",
        required: false,
        defaultValue: 99.99,
      },
    ]);
  });

  it("Should extract values from arrays", () => {
    const query = `
      {
        dbo_products(where: { product_id: { in: [1, 2, 3] } }) {
          product_id
          name
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 1,
      },
      {
        name: "static_1",
        type: "Int",
        required: false,
        defaultValue: 2,
      },
      {
        name: "static_2",
        type: "Int",
        required: false,
        defaultValue: 3,
      },
    ]);
  });

  it("Should not extract GraphQL variables (only static values)", () => {
    const query = `
      query GetOrder($orderId: Int!) {
        dbo_orders(where: { order_id: { eq: $orderId } }) {
          order_id
          customer_id
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "orderId",
        type: "Int!",
        required: true,
      },
    ]);
  });

  it("Should extract static values alongside GraphQL variables", () => {
    const query = `
      query GetProducts($minPrice: Float!) {
        dbo_products(where: { 
          price: { gte: $minPrice, lte: 1000 }
        }) {
          product_id
          name
          price
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "minPrice",
        type: "Float!",
        required: true,
      },
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 1000,
      },
    ]);
  });

  it("Should handle limit and offset arguments", () => {
    const query = `
      {
        dbo_products(limit: 10, offset: 20) {
          product_id
          name
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    expect(result.operations[0].variables).toEqual([
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 10,
      },
      {
        name: "static_1",
        type: "Int",
        required: false,
        defaultValue: 20,
      },
    ]);
  });

  it("Should merge declared variables with generated static variables", () => {
    const query = `
      query GetProducts($minPrice: Float!, $productName: String, $isActive: Boolean = true) {
        dbo_products(where: { 
          price: { gte: $minPrice, lte: 500 },
          name: { eq: $productName },
          is_active: { eq: $isActive }
        }, limit: 25) {
          product_id
          name
          price
        }
      }
    `;

    const result = analyzeQuery(query, StoreMSSQL, StoreMSSQL.schema);

    // Should have declared variables first, then generated static variables
    expect(result.operations[0].variables).toEqual([
      {
        name: "minPrice",
        type: "Float!",
        required: true,
      },
      {
        name: "productName",
        type: "String",
        required: false,
      },
      {
        name: "isActive",
        type: "Boolean",
        required: false,
        defaultValue: true,
      },
      {
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 500,
      },
      {
        name: "static_1",
        type: "Int",
        required: false,
        defaultValue: 25,
      },
    ]);

    // Verify the arguments use variable references
    const productField = result.operations[0].fields[0];
    expect(productField.arguments?.where).toEqual({
      price: { gte: "$minPrice", lte: "$static_0" },
      name: { eq: "$productName" },
      is_active: { eq: "$isActive" },
    });
    expect(productField.arguments?.limit).toBe("$static_1");
  });
});

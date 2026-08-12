import { describe, expect, it } from "bun:test";

import {
  ordDirectiveOptionalQuery,
  ordDirectiveRequiredQuery,
  ordQuery,
  ordWithSkipTrueDirectiveQuery,
  prodQuery,
  prodWhereArgumentNestedEntitiesQuery,
  prodWhereArgumentNestedQuery,
  prodWhereArgumentQuery,
  prodWhereArgumentVariableAndStaticQuery,
  prodWhereArgumentVariableQuery,
} from "../__test/fixtures/queries";
import { EntitySource } from "../types/resolver";

describe("Store", () => {
  it("Should analyze a simple query", () => {
    expect(prodQuery).toEqual({
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [
            {
              name: "dbo_products",
              source: EntitySource.TABLE,
              isArray: true,
              isRequired: true,
              selections: [
                {
                  isRequired: true,
                  name: "product_id",
                },
                {
                  isRequired: true,
                  name: "name",
                },
                {
                  isRequired: true,
                  name: "sku",
                },
                {
                  isRequired: true,
                  name: "price",
                },
                {
                  isRequired: true,
                  name: "dbo_product_categories",
                  isArray: true,
                  selections: [
                    {
                      isRequired: true,
                      name: "category_id",
                    },
                    {
                      isRequired: true,
                      name: "dbo_categories",
                      selections: [
                        {
                          isRequired: true,
                          name: "name",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a query with where argument", () => {
    expect(prodWhereArgumentQuery).toEqual({
      operations: [
        {
          name: null,
          operation: "query",
          variables: [
            {
              name: "static_0",
              type: "String",
              required: false,
              defaultValue: "Running Shoes",
            },
          ],
          fields: [
            {
              name: "dbo_products",
              source: EntitySource.TABLE,
              isRequired: true,
              isArray: true,
              arguments: {
                where: {
                  name: {
                    eq: "$static_0",
                  },
                },
              },
              selections: [
                {
                  isRequired: true,
                  name: "product_id",
                },
                {
                  isRequired: true,
                  name: "name",
                },
                {
                  isRequired: true,
                  name: "sku",
                },
                {
                  isRequired: true,
                  name: "dbo_product_categories",
                  isArray: true,
                  selections: [
                    {
                      isRequired: true,
                      name: "category_id",
                    },
                    {
                      isRequired: true,
                      name: "dbo_categories",
                      selections: [
                        {
                          isRequired: true,
                          name: "name",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a query with where argument nested", () => {
    expect(prodWhereArgumentNestedQuery).toEqual({
      operations: [
        {
          name: null,
          operation: "query",
          variables: [
            {
              name: "static_0",
              type: "Int",
              required: false,
              defaultValue: 1,
            },
          ],
          fields: [
            {
              isRequired: true,
              name: "dbo_products",
              source: EntitySource.TABLE,
              isArray: true,
              selections: [
                {
                  isRequired: true,
                  name: "product_id",
                },
                {
                  isRequired: true,
                  name: "name",
                },
                {
                  isRequired: true,
                  name: "sku",
                },
                {
                  arguments: {
                    where: {
                      quantity: {
                        gt: "$static_0",
                      },
                    },
                  },
                  isArray: true,
                  isRequired: true,
                  name: "dbo_order_items",
                  selections: [
                    {
                      isRequired: true,
                      name: "quantity",
                    },
                    {
                      isRequired: true,
                      name: "unit_price",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a query with where argument with nested entities", () => {
    expect(prodWhereArgumentNestedEntitiesQuery).toEqual({
      operations: [
        {
          name: null,
          operation: "query",
          variables: [
            {
              name: "static_0",
              type: "Int",
              defaultValue: 4,
              required: false,
            },
          ],
          fields: [
            {
              isRequired: true,
              name: "dbo_products",
              source: EntitySource.TABLE,
              isArray: true,
              arguments: {
                where: {
                  dbo_reviews: {
                    rating: {
                      gte: "$static_0",
                    },
                  },
                },
              },
              selections: [
                {
                  isRequired: true,
                  name: "product_id",
                },
                {
                  isRequired: true,
                  name: "name",
                },
                {
                  isRequired: true,
                  name: "sku",
                },
                {
                  isRequired: true,
                  name: "dbo_order_items",
                  selections: [
                    {
                      isRequired: true,
                      name: "quantity",
                    },
                  ],
                  isArray: true,
                },
              ],
            },
          ],
        },
      ],
      fragments: [],
    });
  });
});

describe("Orders", () => {
  it("Should analyze a simple query", () => {
    expect(ordQuery).toEqual({
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [
            {
              name: "dbo_orders",
              source: EntitySource.TABLE,
              isRequired: true,
              isArray: true,
              selections: [
                {
                  isRequired: true,
                  name: "order_id",
                },
                {
                  isRequired: true,
                  name: "customer_id",
                },
                {
                  isRequired: true,
                  name: "total_amount",
                },
                {
                  isRequired: true,
                  name: "dbo_customers",
                  selections: [
                    {
                      isRequired: true,
                      name: "first_name",
                    },
                    {
                      isRequired: true,
                      name: "last_name",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      fragments: [],
    });
  });
});

describe("Common", () => {
  it("Should analyze a simple query with directives", () => {
    expect(ordWithSkipTrueDirectiveQuery).toEqual({
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [
            {
              isRequired: true,
              name: "dbo_orders",
              source: EntitySource.TABLE,
              isArray: true,
              selections: [
                {
                  isRequired: true,
                  name: "order_id",
                },
                {
                  isRequired: true,
                  name: "customer_id",
                },
                {
                  name: "dbo_customers",
                  selections: [
                    {
                      isRequired: true,
                      name: "first_name",
                    },
                  ],
                  directives: [
                    {
                      arguments: {
                        if: true,
                      },
                      name: "skip",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a simple query with directives value coming from variables (optional)", () => {
    expect(ordDirectiveOptionalQuery).toEqual({
      operations: [
        {
          name: "Orders",
          operation: "query",
          fields: [
            {
              isRequired: true,
              name: "dbo_orders",
              source: EntitySource.TABLE,
              isArray: true,
              selections: [
                {
                  isRequired: true,
                  name: "order_id",
                },
                {
                  isRequired: true,
                  name: "customer_id",
                },
                {
                  name: "dbo_customers",
                  selections: [
                    {
                      isRequired: true,
                      name: "first_name",
                    },
                  ],
                  directives: [
                    {
                      arguments: {
                        if: "$val",
                      },
                      name: "include",
                    },
                  ],
                },
              ],
            },
          ],
          variables: [
            {
              name: "val",
              type: "Boolean",
              defaultValue: false,
              required: false,
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a simple query with directives value coming from variables (required)", () => {
    expect(ordDirectiveRequiredQuery).toEqual({
      operations: [
        {
          name: "Orders",
          operation: "query",
          fields: [
            {
              isRequired: true,
              name: "dbo_orders",
              source: EntitySource.TABLE,
              isArray: true,
              selections: [
                {
                  isRequired: true,
                  name: "order_id",
                },
                {
                  isRequired: true,
                  name: "customer_id",
                },
                {
                  name: "dbo_customers",
                  selections: [
                    {
                      isRequired: true,
                      name: "first_name",
                    },
                  ],
                  directives: [
                    {
                      arguments: {
                        if: "$val",
                      },
                      name: "include",
                    },
                  ],
                },
              ],
            },
          ],
          variables: [
            {
              name: "val",
              type: "Boolean!",
              required: true,
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a query with a variable", () => {
    expect(prodWhereArgumentVariableQuery).toEqual({
      operations: [
        {
          fields: [
            {
              arguments: {
                where: {
                  name: {
                    eq: "$productName",
                  },
                },
              },
              isArray: true,
              isRequired: true,
              name: "dbo_products",
              source: EntitySource.TABLE,
              selections: [
                {
                  isRequired: true,
                  name: "product_id",
                },
                {
                  isRequired: true,
                  name: "name",
                },
                {
                  isRequired: true,
                  name: "sku",
                },
                {
                  isArray: true,
                  isRequired: true,
                  name: "dbo_product_categories",
                  selections: [
                    {
                      isRequired: true,
                      name: "category_id",
                    },
                    {
                      isRequired: true,
                      name: "dbo_categories",
                      selections: [
                        {
                          isRequired: true,
                          name: "name",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          name: "Products",
          operation: "query",
          variables: [
            {
              name: "productName",
              type: "String!",
              required: true,
            },
          ],
        },
      ],
      fragments: [],
    });
  });

  it("Should analyze a query with a variable and static value", () => {
    expect(prodWhereArgumentVariableAndStaticQuery).toEqual({
      operations: [
        {
          fields: [
            {
              arguments: {
                where: {
                  is_active: {
                    eq: "$static_0",
                  },
                  name: {
                    eq: "$productName",
                  },
                },
              },
              isArray: true,
              isRequired: true,
              name: "dbo_products",
              source: EntitySource.TABLE,
              selections: [
                {
                  isRequired: true,
                  name: "product_id",
                },
                {
                  isRequired: true,
                  name: "name",
                },
                {
                  isRequired: true,
                  name: "sku",
                },
                {
                  isArray: true,
                  isRequired: true,
                  name: "dbo_product_categories",
                  selections: [
                    {
                      isRequired: true,
                      name: "category_id",
                    },
                    {
                      isRequired: true,
                      name: "dbo_categories",
                      selections: [
                        {
                          isRequired: true,
                          name: "name",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          name: "Products",
          operation: "query",
          variables: [
            {
              name: "productName",
              type: "String!",
              required: true,
            },
            {
              name: "static_0",
              type: "Int",
              required: false,
              defaultValue: 1,
            },
          ],
        },
      ],
      fragments: [],
    });
  });
});

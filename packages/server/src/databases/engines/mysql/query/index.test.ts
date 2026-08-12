import { describe, expect, it } from "bun:test";

import { StoreMySQL } from "../../../../__test/dataset/store";
import {
  ordDirectiveOptionalQuery,
  ordDirectiveRequiredQuery,
  ordGroupByQuery,
  ordQuery,
  ordWithIncludeFalseDirectiveQuery,
  ordWithIncludeTrueDirectiveQuery,
  ordWithSkipFalseDirectiveQuery,
  ordWithSkipTrueDirectiveQuery,
  ordWithWhenAndDirectiveQuery,
  ordWithWhenOrDirectiveQuery,
  prodLimitQuery,
  prodQuery,
  prodWhereArgumentNestedEntitiesQuery,
  prodWhereArgumentNestedQuery,
  prodWhereArgumentQuery,
  prodWithAbsDirectiveQuery,
  prodWithCeilDirectiveQuery,
  prodWithChainedDirectivesQuery,
  prodWithConcatDirectiveQuery,
  prodWithDefaultDirectiveQuery,
  prodWithDivideDirectiveQuery,
  prodWithFloorDirectiveQuery,
  prodWithLowercaseDirectiveQuery,
  prodWithMathChainDirectivesQuery,
  prodWithMultiplyDirectiveQuery,
  prodWithPadDirectiveQuery,
  prodWithReplaceDirectiveQuery,
  prodWithRoundDirectiveQuery,
  prodWithSubstringDirectiveQuery,
  prodWithTrimDirectiveQuery,
  prodWithTruncateDirectiveQuery,
  prodWithUppercaseDirectiveQuery,
} from "../../../../__test/fixtures/queries";
import { format, genSql } from "../format";

describe("MySQL: Store", () => {
  it("Should generate a query without arguments", () => {
    expect(genSql(StoreMySQL, prodQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      t1.name, 
                      'sku', 
                      t1.sku, 
                      'price', 
                      t1.price, 
                      'dbo_product_categories', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_ARRAYAGG(
                              JSON_OBJECT(
                                'category_id', 
                                t2.category_id, 
                                'dbo_categories', 
                                COALESCE(
                                  (
                                    SELECT 
                                      JSON_OBJECT('name', t3.name) 
                                    FROM 
                                      dbo.categories t3 
                                    WHERE 
                                      t2.category_id = t3.category_id
                                  ), 
                                  null
                                )
                              )
                            ) 
                          FROM 
                            dbo.product_categories t2 
                          WHERE 
                            t1.product_id = t2.product_id
                        ), 
                        JSON_ARRAY()
                      )
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate a query with where argument", () => {
    expect(genSql(StoreMySQL, prodWhereArgumentQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      t1.name, 
                      'sku', 
                      t1.sku, 
                      'dbo_product_categories', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_ARRAYAGG(
                              JSON_OBJECT(
                                'category_id', 
                                t2.category_id, 
                                'dbo_categories', 
                                COALESCE(
                                  (
                                    SELECT 
                                      JSON_OBJECT('name', t3.name) 
                                    FROM 
                                      dbo.categories t3 
                                    WHERE 
                                      t2.category_id = t3.category_id
                                  ), 
                                  null
                                )
                              )
                            ) 
                          FROM 
                            dbo.product_categories t2 
                          WHERE 
                            t1.product_id = t2.product_id
                        ), 
                        JSON_ARRAY()
                      )
                    )
                  ) 
                FROM 
                  dbo.products t1 
                WHERE 
                  t1.name = $1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate a query with where argument inside a subfield", () => {
    expect(genSql(StoreMySQL, prodWhereArgumentNestedQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      t1.name, 
                      'sku', 
                      t1.sku, 
                      'dbo_order_items', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_ARRAYAGG(
                              JSON_OBJECT(
                                'quantity', t2.quantity, 'unit_price', 
                                t2.unit_price
                              )
                            ) 
                          FROM 
                            dbo.order_items t2 
                          WHERE 
                            t2.quantity > $1 
                            AND t1.product_id = t2.product_id
                        ), 
                        JSON_ARRAY()
                      )
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate a query with where argument nested with multiple subfield", () => {
    expect(genSql(StoreMySQL, prodWhereArgumentNestedEntitiesQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      t1.name, 
                      'sku', 
                      t1.sku, 
                      'dbo_order_items', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_ARRAYAGG(
                              JSON_OBJECT('quantity', t2.quantity)
                            ) 
                          FROM 
                            dbo.order_items t2 
                          WHERE 
                            t1.product_id = t2.product_id
                        ), 
                        JSON_ARRAY()
                      )
                    )
                  ) 
                FROM 
                  dbo.products t1 
                WHERE 
                  EXISTS (
                    SELECT 
                      1 
                    FROM 
                      dbo.reviews t2 
                    WHERE 
                      t1.product_id = t2.product_id 
                      AND (t2.rating >= $1)
                  )
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });
});

describe("MySQL: Orders", () => {
  it("Should generate a query without arguments", () => {
    expect(genSql(StoreMySQL, ordQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', 
                      t1.order_id, 
                      'customer_id', 
                      t1.customer_id, 
                      'total_amount', 
                      t1.total_amount, 
                      'dbo_customers', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_OBJECT(
                              'first_name', t2.first_name, 'last_name', 
                              t2.last_name
                            ) 
                          FROM 
                            dbo.customers t2 
                          WHERE 
                            t1.customer_id = t2.customer_id
                        ), 
                        null
                      )
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });
});

describe("MySQL: Common", () => {
  it("Example of hash generation from a sub-query to handle subscription behavior", () => {
    expect(genSql(StoreMySQL, prodQuery, {}, true)).toBe(
      format(`
        SELECT 
          MD5(
            (
              COALESCE(
                (
                  SELECT 
                    JSON_ARRAYAGG(
                      JSON_OBJECT(
                        'product_id', 
                        t1.product_id, 
                        'name', 
                        t1.name, 
                        'sku', 
                        t1.sku, 
                        'price', 
                        t1.price, 
                        'dbo_product_categories', 
                        COALESCE(
                          (
                            SELECT 
                              JSON_ARRAYAGG(
                                JSON_OBJECT(
                                  'category_id', 
                                  t2.category_id, 
                                  'dbo_categories', 
                                  COALESCE(
                                    (
                                      SELECT 
                                        JSON_OBJECT('name', t3.name) 
                                      FROM 
                                        dbo.categories t3 
                                      WHERE 
                                        t2.category_id = t3.category_id
                                    ), 
                                    null
                                  )
                                )
                              ) 
                            FROM 
                              dbo.product_categories t2 
                            WHERE 
                              t1.product_id = t2.product_id
                          ), 
                          JSON_ARRAY()
                        )
                      )
                    ) 
                  FROM 
                    dbo.products t1
                ), 
                JSON_ARRAY()
              )
            )
          ) AS ResultHash
      `),
    );
  });

  it("Query with @skip true directive", () => {
    expect(genSql(StoreMySQL, ordWithSkipTrueDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', t1.order_id, 'customer_id', 
                      t1.customer_id
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result

      `),
    );
  });

  it("Query with @skip false directive", () => {
    expect(genSql(StoreMySQL, ordWithSkipFalseDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', 
                      t1.order_id, 
                      'customer_id', 
                      t1.customer_id, 
                      'dbo_customers', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_OBJECT('first_name', t2.first_name) 
                          FROM 
                            dbo.customers t2 
                          WHERE 
                            t1.customer_id = t2.customer_id
                        ), 
                        null
                      )
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Query with @include true directive", () => {
    expect(genSql(StoreMySQL, ordWithIncludeTrueDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', 
                      t1.order_id, 
                      'customer_id', 
                      t1.customer_id, 
                      'dbo_customers', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_OBJECT('first_name', t2.first_name) 
                          FROM 
                            dbo.customers t2 
                          WHERE 
                            t1.customer_id = t2.customer_id
                        ), 
                        null
                      )
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Query with @include false directive", () => {
    expect(genSql(StoreMySQL, ordWithIncludeFalseDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', t1.order_id, 'customer_id', 
                      t1.customer_id
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(and:) - both true should include subfield", () => {
    expect(
      genSql(StoreMySQL, ordWithWhenAndDirectiveQuery, {
        isAdmin: true,
        showDetails: true,
      }),
    ).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', 
                      t1.order_id, 
                      'customer_id', 
                      t1.customer_id, 
                      'dbo_customers', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_OBJECT('first_name', t2.first_name) 
                          FROM 
                            dbo.customers t2 
                          WHERE 
                            t1.customer_id = t2.customer_id
                        ), 
                        null
                      )
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(and:) - one false should exclude subfield", () => {
    expect(
      genSql(StoreMySQL, ordWithWhenAndDirectiveQuery, {
        isAdmin: true,
        showDetails: false,
      }),
    ).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', t1.order_id, 'customer_id', 
                      t1.customer_id
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(or:) - one true should include subfield", () => {
    expect(
      genSql(StoreMySQL, ordWithWhenOrDirectiveQuery, {
        flagA: false,
        flagB: true,
      }),
    ).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', 
                      t1.order_id, 
                      'customer_id', 
                      t1.customer_id, 
                      'dbo_customers', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_OBJECT('first_name', t2.first_name) 
                          FROM 
                            dbo.customers t2 
                          WHERE 
                            t1.customer_id = t2.customer_id
                        ), 
                        null
                      )
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(or:) - both false should exclude subfield", () => {
    expect(
      genSql(StoreMySQL, ordWithWhenOrDirectiveQuery, {
        flagA: false,
        flagB: false,
      }),
    ).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', t1.order_id, 'customer_id', 
                      t1.customer_id
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with directives value coming from variables (optional)", () => {
    expect(genSql(StoreMySQL, ordDirectiveOptionalQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', t1.order_id, 'customer_id', 
                      t1.customer_id
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result

      `),
    );
  });

  it("Should generate query with directives value coming from variables (required, valid query, true)", () => {
    expect(genSql(StoreMySQL, ordDirectiveRequiredQuery, { val: true })).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', 
                      t1.order_id, 
                      'customer_id', 
                      t1.customer_id, 
                      'dbo_customers', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_OBJECT('first_name', t2.first_name) 
                          FROM 
                            dbo.customers t2 
                          WHERE 
                            t1.customer_id = t2.customer_id
                        ), 
                        null
                      )
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with directives value coming from variables (required, valid query, false)", () => {
    expect(genSql(StoreMySQL, ordDirectiveRequiredQuery, { val: false })).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'order_id', t1.order_id, 'customer_id', 
                      t1.customer_id
                    )
                  ) 
                FROM 
                  dbo.orders t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with limit", () => {
    expect(genSql(StoreMySQL, prodLimitQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', t1.product_id, 'name', 
                      t1.name
                    )
                  ) 
                FROM 
                  dbo.products t1 
                ORDER BY 
                  t1.product_id ASC 
                LIMIT 
                  $1 OFFSET 0
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate GROUP BY query with aggregations", () => {
    expect(genSql(StoreMySQL, ordGroupByQuery)).toBe(
      format(`
        WITH t1_agg AS (
          SELECT 
            t1.customer_id, 
            COUNT(*) AS count, 
            MIN(t1.order_id) AS min_order_id, 
            SUM(t1.total_amount) AS sum_total_amount 
          FROM 
            dbo.orders t1 
          GROUP BY 
            t1.customer_id
        ) 
        SELECT 
          JSON_OBJECT(
            'orders', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'count', 
                      t1_agg.count, 
                      'min', 
                      JSON_OBJECT(
                        'order_id', 
                        COALESCE(t1_agg.min_order_id, NULL)
                      ), 
                      'sum', 
                      JSON_OBJECT(
                        'total_amount', 
                        COALESCE(t1_agg.sum_total_amount, NULL)
                      ), 
                      'items', 
                      COALESCE(
                        (
                          SELECT 
                            JSON_ARRAYAGG(
                              JSON_OBJECT(
                                'order_id', t1.order_id, 'customer_id', 
                                t1.customer_id, 'total_amount', 
                                t1.total_amount
                              )
                            ) 
                          FROM 
                            dbo.orders t1 
                          WHERE 
                            t1.customer_id = t1_agg.customer_id
                        ), 
                        JSON_ARRAY()
                      )
                    )
                  ) 
                FROM 
                  t1_agg
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with uppercase directive", () => {
    expect(genSql(StoreMySQL, prodWithUppercaseDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      UPPER(t1.name), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with lowercase directive", () => {
    expect(genSql(StoreMySQL, prodWithLowercaseDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      LOWER(t1.name), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with truncate directive", () => {
    expect(genSql(StoreMySQL, prodWithTruncateDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      LEFT(t1.name, $1), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with default directive", () => {
    expect(genSql(StoreMySQL, prodWithDefaultDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      COALESCE(t1.name, $1), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with trim directive", () => {
    expect(genSql(StoreMySQL, prodWithTrimDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      TRIM(t1.name), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with substring directive", () => {
    expect(genSql(StoreMySQL, prodWithSubstringDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'sku', 
                      SUBSTRING(t1.sku, $1, $2)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with replace directive", () => {
    expect(genSql(StoreMySQL, prodWithReplaceDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      REPLACE(t1.name, $1, $2), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with concat directive", () => {
    expect(genSql(StoreMySQL, prodWithConcatDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'sku', 
                      CONCAT(t1.sku, $1)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with pad directive", () => {
    expect(genSql(StoreMySQL, prodWithPadDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      RIGHT(REPLICATE($2, $1) + CAST(t1.product_id AS VARCHAR(MAX)), $1), 
                      'name', 
                      t1.name
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with round directive", () => {
    expect(genSql(StoreMySQL, prodWithRoundDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      ROUND(t1.price, $1)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with ceil directive", () => {
    expect(genSql(StoreMySQL, prodWithCeilDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      CEILING(t1.price)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with floor directive", () => {
    expect(genSql(StoreMySQL, prodWithFloorDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      FLOOR(t1.price)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with abs directive", () => {
    expect(genSql(StoreMySQL, prodWithAbsDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      ABS(t1.price)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with multiply directive", () => {
    expect(genSql(StoreMySQL, prodWithMultiplyDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      (t1.price * $1)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with divide directive", () => {
    expect(genSql(StoreMySQL, prodWithDivideDirectiveQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      (t1.price / $1)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with chained directives", () => {
    expect(genSql(StoreMySQL, prodWithChainedDirectivesQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'name', 
                      LEFT(UPPER(TRIM(t1.name)), $1), 
                      'sku', 
                      t1.sku
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with math chain directives", () => {
    expect(genSql(StoreMySQL, prodWithMathChainDirectivesQuery)).toBe(
      format(`
        SELECT 
          JSON_OBJECT(
            'dbo_products', 
            COALESCE(
              (
                SELECT 
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'product_id', 
                      t1.product_id, 
                      'price', 
                      ROUND((t1.price * $1), $2)
                    )
                  ) 
                FROM 
                  dbo.products t1
              ), 
              JSON_ARRAY()
            )
          ) as json_result
      `),
    );
  });
});

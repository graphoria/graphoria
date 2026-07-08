import { describe, expect, it } from "bun:test";

import { StorePG } from "../../../../__test/dataset/store";
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

describe("PostgreSQL: Store", () => {
  it("Should generate a query without arguments", () => {
    expect(genSql(StorePG, prodQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      t1."name",
                      'sku',
                      t1."sku",
                      'price',
                      t1."price",
                      'dbo_product_categories',
                      COALESCE(
                        (
                          SELECT
                            json_agg(
                              json_build_object(
                                'category_id',
                                t2."category_id",
                                'dbo_categories',
                                COALESCE(
                                  (
                                    SELECT
                                      json_build_object('name', t3."name")
                                    FROM
                                      "dbo"."categories" t3
                                    WHERE
                                      t2."category_id" = t3."category_id"
                                  ),
                                  'null'::json
                                )
                              )
                            )
                          FROM
                            "dbo"."product_categories" t2
                          WHERE
                            t1."product_id" = t2."product_id"
                        ),
                        '[]'::json
                      )
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate a query with where argument", () => {
    expect(genSql(StorePG, prodWhereArgumentQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      t1."name",
                      'sku',
                      t1."sku",
                      'dbo_product_categories',
                      COALESCE(
                        (
                          SELECT
                            json_agg(
                              json_build_object(
                                'category_id',
                                t2."category_id",
                                'dbo_categories',
                                COALESCE(
                                  (
                                    SELECT
                                      json_build_object('name', t3."name")
                                    FROM
                                      "dbo"."categories" t3
                                    WHERE
                                      t2."category_id" = t3."category_id"
                                  ),
                                  'null'::json
                                )
                              )
                            )
                          FROM
                            "dbo"."product_categories" t2
                          WHERE
                            t1."product_id" = t2."product_id"
                        ),
                        '[]'::json
                      )
                    )
                  )
                FROM
                  "dbo"."products" t1
                WHERE
                  t1."name" = $1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });
  it("Should generate a query with where argument inside a subfield", () => {
    expect(genSql(StorePG, prodWhereArgumentNestedQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      t1."name",
                      'sku',
                      t1."sku",
                      'dbo_order_items',
                      COALESCE(
                        (
                          SELECT
                            json_agg(json_build_object('quantity', t2."quantity", 'unit_price', t2."unit_price"))
                          FROM
                            "dbo"."order_items" t2
                          WHERE
                            t2."quantity" > $1
                            AND t1."product_id" = t2."product_id"
                        ),
                        '[]'::json
                      )
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate a query with where argument nested with multiple subfield", () => {
    expect(genSql(StorePG, prodWhereArgumentNestedEntitiesQuery, {}, false)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      t1."name",
                      'sku',
                      t1."sku",
                      'dbo_order_items',
                      COALESCE(
                        (
                          SELECT
                            json_agg(json_build_object('quantity', t2."quantity"))
                          FROM
                            "dbo"."order_items" t2
                          WHERE
                            t1."product_id" = t2."product_id"
                        ),
                        '[]'::json
                      )
                    )
                  )
                FROM
                  "dbo"."products" t1
                WHERE
                  EXISTS (
                    SELECT
                      1
                    FROM
                      dbo.reviews t2
                    WHERE
                      t1."product_id" = t2."product_id"
                      AND (t2."rating" >= $1)
                  )
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });
});

describe("PostgreSQL: Orders", () => {
  it("Should generate a query without arguments", () => {
    expect(genSql(StorePG, ordQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id",
                      'total_amount',
                      t1."total_amount",
                      'dbo_customers',
                      COALESCE(
                        (
                          SELECT
                            json_build_object('first_name', t2."first_name", 'last_name', t2."last_name")
                          FROM
                            "dbo"."customers" t2
                          WHERE
                            t1."customer_id" = t2."customer_id"
                        ),
                        'null'::json
                      )
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });
});

describe("PostgreSQL: Common", () => {
  it("Example of hash generation from a sub-query to handle subscription behavior", () => {
    expect(genSql(StorePG, prodQuery, {}, true)).toBe(
      format(`
        SELECT
          MD5(
            (
              COALESCE(
                (
                  SELECT
                    json_agg(
                      json_build_object(
                        'product_id',
                        t1."product_id",
                        'name',
                        t1."name",
                        'sku',
                        t1."sku",
                        'price',
                        t1."price",
                        'dbo_product_categories',
                        COALESCE(
                          (
                            SELECT
                              json_agg(
                                json_build_object(
                                  'category_id',
                                  t2."category_id",
                                  'dbo_categories',
                                  COALESCE(
                                    (
                                      SELECT
                                        json_build_object('name', t3."name")
                                      FROM
                                        "dbo"."categories" t3
                                      WHERE
                                        t2."category_id" = t3."category_id"
                                    ),
                                    'null'::json
                                  )
                                )
                              )
                            FROM
                              "dbo"."product_categories" t2
                            WHERE
                              t1."product_id" = t2."product_id"
                          ),
                          '[]'::json
                        )
                      )
                    )
                  FROM
                    "dbo"."products" t1
                ),
                '[]'::json
              )
            )::text
          ) AS "ResultHash"
      `),
    );
  });
  it("Query with @skip true directive", () => {
    expect(genSql(StorePG, ordWithSkipTrueDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object('order_id', t1."order_id", 'customer_id', t1."customer_id")
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @skip false directive", () => {
    expect(genSql(StorePG, ordWithSkipFalseDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id",
                      'dbo_customers',
                      COALESCE(
                        (
                          SELECT
                            json_build_object('first_name', t2."first_name")
                          FROM
                            "dbo"."customers" t2
                          WHERE
                            t1."customer_id" = t2."customer_id"
                        ),
                        'null'::json
                      )
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @include true directive", () => {
    expect(genSql(StorePG, ordWithIncludeTrueDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id",
                      'dbo_customers',
                      COALESCE(
                        (
                          SELECT
                            json_build_object('first_name', t2."first_name")
                          FROM
                            "dbo"."customers" t2
                          WHERE
                            t1."customer_id" = t2."customer_id"
                        ),
                        'null'::json
                      )
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @include false directive", () => {
    expect(genSql(StorePG, ordWithIncludeFalseDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object('order_id', t1."order_id", 'customer_id', t1."customer_id")
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(and:) - both true should include subfield", () => {
    expect(
      genSql(StorePG, ordWithWhenAndDirectiveQuery, {
        isAdmin: true,
        showDetails: true,
      }),
    ).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id",
                      'dbo_customers',
                      COALESCE(
                        (
                          SELECT
                            json_build_object('first_name', t2."first_name")
                          FROM
                            "dbo"."customers" t2
                          WHERE
                            t1."customer_id" = t2."customer_id"
                        ),
                        'null'::json
                      )
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(and:) - one false should exclude subfield", () => {
    expect(
      genSql(StorePG, ordWithWhenAndDirectiveQuery, {
        isAdmin: true,
        showDetails: false,
      }),
    ).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object('order_id', t1."order_id", 'customer_id', t1."customer_id")
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(or:) - one true should include subfield", () => {
    expect(
      genSql(StorePG, ordWithWhenOrDirectiveQuery, {
        flagA: false,
        flagB: true,
      }),
    ).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id",
                      'dbo_customers',
                      COALESCE(
                        (
                          SELECT
                            json_build_object('first_name', t2."first_name")
                          FROM
                            "dbo"."customers" t2
                          WHERE
                            t1."customer_id" = t2."customer_id"
                        ),
                        'null'::json
                      )
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Query with @when(or:) - both false should exclude subfield", () => {
    expect(
      genSql(StorePG, ordWithWhenOrDirectiveQuery, {
        flagA: false,
        flagB: false,
      }),
    ).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object('order_id', t1."order_id", 'customer_id', t1."customer_id")
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with directives value coming from variables (optional)", () => {
    expect(genSql(StorePG, ordDirectiveOptionalQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id"
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with directives value coming from variables (required, valid query, true)", () => {
    expect(genSql(StorePG, ordDirectiveRequiredQuery, { val: true })).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'order_id',
                      t1."order_id",
                      'customer_id',
                      t1."customer_id",
                      'dbo_customers',
                      COALESCE(
                        (
                          SELECT
                            json_build_object('first_name', t2."first_name")
                          FROM
                            "dbo"."customers" t2
                          WHERE
                            t1."customer_id" = t2."customer_id"
                        ),
                        'null'::json
                      )
                    )
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
        `),
    );
  });

  it("Should generate query with directives value coming from variables (required, valid query, false)", () => {
    expect(genSql(StorePG, ordDirectiveRequiredQuery, { val: false })).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object('order_id', t1."order_id", 'customer_id', t1."customer_id")
                  )
                FROM
                  "dbo"."orders" t1
              ),
              '[]'::json
            )
          ) as json_result
        `),
    );
  });

  it("Should generate query with limit", () => {
    expect(genSql(StorePG, prodLimitQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      t1."name"
                    )
                    ORDER BY
                      t1."product_id" ASC
                  )
                FROM
                  "dbo"."products" t1
                LIMIT
                  $1
                OFFSET
                  0
              ),
              '[]'::json
            )
          ) as json_result
        `),
    );
  });

  it("Should generate GROUP BY query with aggregations", () => {
    expect(genSql(StorePG, ordGroupByQuery)).toBe(
      format(`
        WITH
          t1_agg AS (
            SELECT
              t1."customer_id",
              COUNT(*) AS count,
              MIN(t1."order_id") AS min_order_id,
              SUM(t1."total_amount") AS sum_total_amount
            FROM
              "dbo"."orders" t1
            GROUP BY
              t1."customer_id"
          )
        SELECT
          json_build_object(
            'orders',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'count',
                      t1_agg.count,
                      'min',
                      json_build_object('order_id', COALESCE(t1_agg.min_order_id, null)),
                      'sum',
                      json_build_object('total_amount', COALESCE(t1_agg.sum_total_amount, null)),
                      'items',
                      COALESCE(
                        (
                          SELECT
                            json_agg(
                              json_build_object(
                                'order_id',
                                t1."order_id",
                                'customer_id',
                                t1."customer_id",
                                'total_amount',
                                t1."total_amount"
                              )
                            )
                          FROM
                            "dbo"."orders" t1
                          WHERE
                            t1."customer_id" = t1_agg."customer_id"
                        ),
                        '[]'::json
                      )
                    )
                  )
                FROM
                  t1_agg
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with uppercase directive", () => {
    expect(genSql(StorePG, prodWithUppercaseDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      UPPER(t1."name"),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with lowercase directive", () => {
    expect(genSql(StorePG, prodWithLowercaseDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      LOWER(t1."name"),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with truncate directive", () => {
    expect(genSql(StorePG, prodWithTruncateDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      LEFT(t1."name", $1),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with default directive", () => {
    expect(genSql(StorePG, prodWithDefaultDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      COALESCE(t1."name", $1),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with trim directive", () => {
    expect(genSql(StorePG, prodWithTrimDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      TRIM(t1."name"),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with substring directive", () => {
    expect(genSql(StorePG, prodWithSubstringDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'sku',
                      SUBSTRING(t1."sku", $1, $2)
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with replace directive", () => {
    expect(genSql(StorePG, prodWithReplaceDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      REPLACE(t1."name", $1, $2),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with concat directive", () => {
    expect(genSql(StorePG, prodWithConcatDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'sku',
                      CONCAT(t1."sku", $1)
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with pad directive", () => {
    expect(genSql(StorePG, prodWithPadDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      LPAD(t1."product_id"::TEXT, $1, $2),
                      'name',
                      t1."name"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with round directive", () => {
    expect(genSql(StorePG, prodWithRoundDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      ROUND(t1."price", $1)
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with ceil directive", () => {
    expect(genSql(StorePG, prodWithCeilDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      CEIL(t1."price")
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with floor directive", () => {
    expect(genSql(StorePG, prodWithFloorDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      FLOOR(t1."price")
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with abs directive", () => {
    expect(genSql(StorePG, prodWithAbsDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      ABS(t1."price")
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with multiply directive", () => {
    expect(genSql(StorePG, prodWithMultiplyDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      (t1."price" * $1)
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with divide directive", () => {
    expect(genSql(StorePG, prodWithDivideDirectiveQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      (t1."price" / $1)
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with chained directives", () => {
    expect(genSql(StorePG, prodWithChainedDirectivesQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'name',
                      LEFT(UPPER(TRIM(t1."name")), $1),
                      'sku',
                      t1."sku"
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });

  it("Should generate query with math chain directives", () => {
    expect(genSql(StorePG, prodWithMathChainDirectivesQuery)).toBe(
      format(`
        SELECT
          json_build_object(
            'dbo_products',
            COALESCE(
              (
                SELECT
                  json_agg(
                    json_build_object(
                      'product_id',
                      t1."product_id",
                      'price',
                      ROUND((t1."price" * $1), $2)
                    )
                  )
                FROM
                  "dbo"."products" t1
              ),
              '[]'::json
            )
          ) as json_result
      `),
    );
  });
});

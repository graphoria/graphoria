import { describe, expect, it } from "bun:test";

import { StoreMSSQL } from "../../../../__test/dataset/store";
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
import { format, genSql } from "../../mssql/format";

describe("MSSQL: Store", () => {
  it("Should generate a query without arguments", () => {
    expect(genSql(StoreMSSQL, prodQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    t1.name AS name,
                    t1.sku AS sku,
                    t1.price AS price,
                    JSON_QUERY (
                      ISNULL (
                        (
                          SELECT
                            t2.category_id AS category_id,
                            JSON_QUERY (
                              NULLIF(
                                (
                                  SELECT
                                    t3.name AS name
                                  FROM
                                    dbo.categories t3
                                  WHERE
                                    t2.category_id = t3.category_id FOR JSON PATH,
                                    INCLUDE_NULL_VALUES,
                                    WITHOUT_ARRAY_WRAPPER
                                ),
                                ''
                              )
                            ) AS dbo_categories
                          FROM
                            dbo.product_categories t2
                          WHERE
                            t1.product_id = t2.product_id FOR JSON PATH,
                            INCLUDE_NULL_VALUES
                        ),
                        '[]'
                      )
                    ) AS dbo_product_categories
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate a query with where argument", () => {
    expect(genSql(StoreMSSQL, prodWhereArgumentQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    t1.name AS name,
                    t1.sku AS sku,
                    JSON_QUERY (
                      ISNULL (
                        (
                          SELECT
                            t2.category_id AS category_id,
                            JSON_QUERY (
                              NULLIF(
                                (
                                  SELECT
                                    t3.name AS name
                                  FROM
                                    dbo.categories t3
                                  WHERE
                                    t2.category_id = t3.category_id FOR JSON PATH,
                                    INCLUDE_NULL_VALUES,
                                    WITHOUT_ARRAY_WRAPPER
                                ),
                                ''
                              )
                            ) AS dbo_categories
                          FROM
                            dbo.product_categories t2
                          WHERE
                            t1.product_id = t2.product_id FOR JSON PATH,
                            INCLUDE_NULL_VALUES
                        ),
                        '[]'
                      )
                    ) AS dbo_product_categories
                  FROM
                    dbo.products t1
                  WHERE
                    t1.name = @1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate a query with where argument inside a subfield", () => {
    expect(genSql(StoreMSSQL, prodWhereArgumentNestedQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    t1.name AS name,
                    t1.sku AS sku,
                    JSON_QUERY (
                      ISNULL (
                        (
                          SELECT
                            t2.quantity AS quantity,
                            t2.unit_price AS unit_price
                          FROM
                            dbo.order_items t2
                          WHERE
                            t2.quantity > @1
                            AND t1.product_id = t2.product_id FOR JSON PATH,
                            INCLUDE_NULL_VALUES
                        ),
                        '[]'
                      )
                    ) AS dbo_order_items
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate a query with where argument nested with multiple subfield", () => {
    expect(genSql(StoreMSSQL, prodWhereArgumentNestedEntitiesQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    t1.name AS name,
                    t1.sku AS sku,
                    JSON_QUERY (
                      ISNULL (
                        (
                          SELECT
                            t2.quantity AS quantity
                          FROM
                            dbo.order_items t2
                          WHERE
                            t1.product_id = t2.product_id FOR JSON PATH,
                            INCLUDE_NULL_VALUES
                        ),
                        '[]'
                      )
                    ) AS dbo_order_items
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
                        AND (t2.rating >= @1)
                    ) FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });
});

describe("MSSQL: Orders", () => {
  it("Should generate a query without arguments", () => {
    expect(genSql(StoreMSSQL, ordQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.order_id AS order_id,
                    t1.customer_id AS customer_id,
                    t1.total_amount AS total_amount,
                    JSON_QUERY (
                      NULLIF(
                        (
                          SELECT
                            t2.first_name AS first_name,
                            t2.last_name AS last_name
                          FROM
                            dbo.customers t2
                          WHERE
                            t1.customer_id = t2.customer_id FOR JSON PATH,
                            INCLUDE_NULL_VALUES,
                            WITHOUT_ARRAY_WRAPPER
                        ),
                        ''
                      )
                    ) AS dbo_customers
                  FROM
                    dbo.orders t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_orders FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });
});

describe("MSSQL: Common", () => {
  it("Example of hash generation from a sub-query to handle subscription behavior", () => {
    expect(genSql(StoreMSSQL, prodQuery, {}, true)).toBe(
      format(`
        SELECT
          HASHBYTES (
            'MD5',
            (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                      t1.product_id AS product_id,
                      t1.name AS name,
                      t1.sku AS sku,
                      t1.price AS price,
                      JSON_QUERY (
                        ISNULL (
                          (
                            SELECT
                              t2.category_id AS category_id,
                              JSON_QUERY (
                                NULLIF(
                                  (
                                    SELECT
                                      t3.name AS name
                                    FROM
                                      dbo.categories t3
                                    WHERE
                                      t2.category_id = t3.category_id FOR JSON PATH,
                                      INCLUDE_NULL_VALUES,
                                      WITHOUT_ARRAY_WRAPPER
                                  ),
                                  ''
                                )
                              ) AS dbo_categories
                            FROM
                              dbo.product_categories t2
                            WHERE
                              t1.product_id = t2.product_id FOR JSON PATH,
                              INCLUDE_NULL_VALUES
                          ),
                          '[]'
                        )
                      ) AS dbo_product_categories
                    FROM
                      dbo.products t1 FOR JSON PATH,
                      INCLUDE_NULL_VALUES
                  ),
                  '[]'
                )
              )
            )
          ) AS ResultHash
    `),
    );
  });

  it("Query with @skip true directive", () => {
    expect(genSql(StoreMSSQL, ordWithSkipTrueDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.order_id AS order_id,
                    t1.customer_id AS customer_id
                  FROM
                    dbo.orders t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_orders FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @skip false directive", () => {
    expect(genSql(StoreMSSQL, ordWithSkipFalseDirectiveQuery)).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id,
                  JSON_QUERY (
                        NULLIF(
                          (
                            SELECT
                          t2.first_name AS first_name
                        FROM
                          dbo.customers t2
                        WHERE
                          t1.customer_id = t2.customer_id FOR JSON PATH,
                          INCLUDE_NULL_VALUES,
                          WITHOUT_ARRAY_WRAPPER
                      ),
                      ''
                    )
                  ) AS dbo_customers
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @include true directive", () => {
    expect(genSql(StoreMSSQL, ordWithIncludeTrueDirectiveQuery)).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id,
                  JSON_QUERY (
                        NULLIF(
                          (
                            SELECT
                          t2.first_name AS first_name
                        FROM
                          dbo.customers t2
                        WHERE
                          t1.customer_id = t2.customer_id FOR JSON PATH,
                          INCLUDE_NULL_VALUES,
                          WITHOUT_ARRAY_WRAPPER
                      ),
                      ''
                    )
                  ) AS dbo_customers
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @include false directive", () => {
    expect(genSql(StoreMSSQL, ordWithIncludeFalseDirectiveQuery)).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @when(and:) - both true should include subfield", () => {
    expect(
      genSql(StoreMSSQL, ordWithWhenAndDirectiveQuery, {
        isAdmin: true,
        showDetails: true,
      }),
    ).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id,
                  JSON_QUERY (
                        NULLIF(
                          (
                            SELECT
                          t2.first_name AS first_name
                        FROM
                          dbo.customers t2
                        WHERE
                          t1.customer_id = t2.customer_id FOR JSON PATH,
                          INCLUDE_NULL_VALUES,
                          WITHOUT_ARRAY_WRAPPER
                      ),
                      ''
                    )
                  ) AS dbo_customers
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @when(and:) - one false should exclude subfield", () => {
    expect(
      genSql(StoreMSSQL, ordWithWhenAndDirectiveQuery, {
        isAdmin: true,
        showDetails: false,
      }),
    ).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @when(or:) - one true should include subfield", () => {
    expect(
      genSql(StoreMSSQL, ordWithWhenOrDirectiveQuery, {
        flagA: false,
        flagB: true,
      }),
    ).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id,
                  JSON_QUERY (
                        NULLIF(
                          (
                            SELECT
                          t2.first_name AS first_name
                        FROM
                          dbo.customers t2
                        WHERE
                          t1.customer_id = t2.customer_id FOR JSON PATH,
                          INCLUDE_NULL_VALUES,
                          WITHOUT_ARRAY_WRAPPER
                      ),
                      ''
                    )
                  ) AS dbo_customers
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Query with @when(or:) - both false should exclude subfield", () => {
    expect(
      genSql(StoreMSSQL, ordWithWhenOrDirectiveQuery, {
        flagA: false,
        flagB: false,
      }),
    ).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with directives value coming from variables (optional)", () => {
    expect(genSql(StoreMSSQL, ordDirectiveOptionalQuery)).toBe(
      format(`
      SELECT
      (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                t1.order_id AS order_id,
                t1.customer_id AS customer_id
              FROM
                dbo.orders t1 FOR JSON PATH,
                INCLUDE_NULL_VALUES
            ),
            '[]'
          )
        )
      ) as dbo_orders FOR JSON PATH,
      INCLUDE_NULL_VALUES,
      WITHOUT_ARRAY_WRAPPER
    `),
    );
  });

  it("Should generate query with directives value coming from variables (required, valid query, true)", () => {
    expect(genSql(StoreMSSQL, ordDirectiveRequiredQuery, { val: true })).toBe(
      format(`
        SELECT
        (
          JSON_QUERY (
            ISNULL (
              (
                SELECT
                t1.order_id AS order_id,
                t1.customer_id AS customer_id,
                  JSON_QUERY (
                    NULLIF(
                      (
                        SELECT
                        t2.first_name AS first_name
                        FROM
                        dbo.customers t2
                        WHERE
                          t1.customer_id = t2.customer_id FOR JSON PATH,
                          INCLUDE_NULL_VALUES,
                          WITHOUT_ARRAY_WRAPPER
                      ),
                      ''
                    )
                  ) AS dbo_customers
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with directives value coming from variables (required, valid query, false)", () => {
    expect(genSql(StoreMSSQL, ordDirectiveRequiredQuery, { val: false })).toBe(
      format(`
        SELECT
        (
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                  t1.order_id AS order_id,
                  t1.customer_id AS customer_id
                FROM
                  dbo.orders t1 FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_orders FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with limit", () => {
    expect(genSql(StoreMSSQL, prodLimitQuery)).toBe(
      format(`
        SELECT
        (
          JSON_QUERY (
            ISNULL (
              (
                SELECT
                  t1.product_id AS product_id,
                  t1.name AS name
                FROM
                  dbo.products t1
                ORDER BY
                  t1.product_id ASC
                OFFSET
                  0 ROWS
                FETCH NEXT
                  @1 ROWS ONLY FOR JSON PATH,
                  INCLUDE_NULL_VALUES
              ),
              '[]'
            )
          )
        ) as dbo_products FOR JSON PATH,
        INCLUDE_NULL_VALUES,
        WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate GROUP BY query with aggregations", () => {
    expect(genSql(StoreMSSQL, ordGroupByQuery)).toBe(
      format(`
        WITH
          t1_agg AS (
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
          (
            SELECT
              t1_agg.count AS count,
              JSON_QUERY (
                (
                  SELECT
                    t1_agg.min_order_id AS order_id FOR JSON PATH,
                    WITHOUT_ARRAY_WRAPPER,
                    INCLUDE_NULL_VALUES
                )
              ) AS min,
              JSON_QUERY (
                (
                  SELECT
                    t1_agg.sum_total_amount AS total_amount FOR JSON PATH,
                    WITHOUT_ARRAY_WRAPPER,
                    INCLUDE_NULL_VALUES
                )
              ) AS sum,
              JSON_QUERY (
                ISNULL (
                  (
                    SELECT
                      t1.order_id AS order_id,
                      t1.customer_id AS customer_id,
                      t1.total_amount AS total_amount
                    FROM
                      dbo.orders t1
                    WHERE
                      t1.customer_id = t1_agg.customer_id FOR JSON PATH,
                      INCLUDE_NULL_VALUES
                  ),
                  '[]'
                )
              ) AS items
            FROM
              t1_agg FOR JSON PATH,
              INCLUDE_NULL_VALUES
          ) as orders FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with uppercase directive", () => {
    expect(genSql(StoreMSSQL, prodWithUppercaseDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    UPPER(t1.name) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with lowercase directive", () => {
    expect(genSql(StoreMSSQL, prodWithLowercaseDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    LOWER(t1.name) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with truncate directive", () => {
    expect(genSql(StoreMSSQL, prodWithTruncateDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    LEFT(t1.name, @1) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with default directive", () => {
    expect(genSql(StoreMSSQL, prodWithDefaultDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    COALESCE(t1.name, @1) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with trim directive", () => {
    expect(genSql(StoreMSSQL, prodWithTrimDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    TRIM(t1.name) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with substring directive", () => {
    expect(genSql(StoreMSSQL, prodWithSubstringDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    SUBSTRING(t1.sku, @1, @2) AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with replace directive", () => {
    expect(genSql(StoreMSSQL, prodWithReplaceDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    REPLACE(t1.name, @1, @2) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with concat directive", () => {
    expect(genSql(StoreMSSQL, prodWithConcatDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    CONCAT(t1.sku, @1) AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with pad directive", () => {
    expect(genSql(StoreMSSQL, prodWithPadDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    RIGHT(REPLICATE(@2, @1) + CAST(t1.product_id AS VARCHAR(MAX)),
               @1) AS product_id,
                    t1.name AS name
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with round directive", () => {
    expect(genSql(StoreMSSQL, prodWithRoundDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    ROUND(t1.price, @1) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with ceil directive", () => {
    expect(genSql(StoreMSSQL, prodWithCeilDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    CEILING(t1.price) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with floor directive", () => {
    expect(genSql(StoreMSSQL, prodWithFloorDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    FLOOR(t1.price) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with abs directive", () => {
    expect(genSql(StoreMSSQL, prodWithAbsDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    ABS(t1.price) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with multiply directive", () => {
    expect(genSql(StoreMSSQL, prodWithMultiplyDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    (t1.price * @1) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with divide directive", () => {
    expect(genSql(StoreMSSQL, prodWithDivideDirectiveQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    (t1.price / @1) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with chained directives", () => {
    expect(genSql(StoreMSSQL, prodWithChainedDirectivesQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    LEFT(UPPER(TRIM(t1.name)), @1) AS name,
                    t1.sku AS sku
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });

  it("Should generate query with math chain directives", () => {
    expect(genSql(StoreMSSQL, prodWithMathChainDirectivesQuery)).toBe(
      format(`
        SELECT
          (
            JSON_QUERY (
              ISNULL (
                (
                  SELECT
                    t1.product_id AS product_id,
                    ROUND((t1.price * @1), @2) AS price
                  FROM
                    dbo.products t1 FOR JSON PATH,
                    INCLUDE_NULL_VALUES
                ),
                '[]'
              )
            )
          ) as dbo_products FOR JSON PATH,
          INCLUDE_NULL_VALUES,
          WITHOUT_ARRAY_WRAPPER
      `),
    );
  });
});

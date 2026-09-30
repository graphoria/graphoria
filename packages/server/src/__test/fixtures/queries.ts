import { analyzeQuery } from "../../analyzeQuery";
import { StoreMSSQL } from "../dataset/store";

// ============================================================================
// Products Queries
// ============================================================================

export const prodQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name
        sku
        price
        dbo_product_categories {
          category_id
          dbo_categories {
            name
          }
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodLimitQuery = analyzeQuery(
  `
    {
      dbo_products(orderBy: [{ product_id: ASC }], limit: 10) {
        product_id
        name
      }
    }
  `,
  StoreMSSQL,
);

export const prodWhereArgumentQuery = analyzeQuery(
  `
    {
      dbo_products(where: { name: { eq: "Running Shoes" } }) {
        product_id
        name
        sku
        dbo_product_categories {
          category_id
          dbo_categories {
            name
          }
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodWhereArgumentNestedQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name
        sku
        dbo_order_items(where: {quantity: {gt: 1}}) {
          quantity
          unit_price
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodWhereArgumentNestedEntitiesQuery = analyzeQuery(
  `
    {
      dbo_products(where: { dbo_reviews: { rating: { gte: 4 } } }) {
        product_id
        name
        sku
        dbo_order_items {
          quantity
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodWhereArgumentDeeplyNestedEntitiesQuery = analyzeQuery(
  `
    {
      dbo_products(where: { dbo_reviews: { dbo_customers: { email: { eq: "vip@example.com" } } } }) {
        product_id
        name
        sku
        dbo_order_items {
          quantity
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodGroupByQuery = analyzeQuery(
  `
    {
      dbo_products(groupBy: ["is_active"]) {
        count
        min {
          product_id
          price
        }
        sum {
          price
        }
        avg {
          price
        }
        items {
          product_id
          name
          price
        }
      }
    }
  `,
  StoreMSSQL,
);

// ============================================================================
// Orders Queries
// ============================================================================

export const ordQuery = analyzeQuery(
  `
    {
      dbo_orders {
        order_id
        customer_id
        total_amount
        dbo_customers {
          first_name
          last_name
        }
      }
    }
  `,
  StoreMSSQL,
);

export const ordGroupByQuery = analyzeQuery(
  `
    query getOrderSummary {
      orders: dbo_orders_aggregate(groupBy: [customer_id]) {
        count
        min {
          order_id
        }
        sum {
          total_amount
        }
        items {
          order_id
          customer_id
          total_amount
        }
      }
    }
  `,
  StoreMSSQL,
);

// Aggregate with a data-transform directive on a `key` field and an `items` field.
// @dateFormat is unsupported on MySQL, so this fixture is only used for PG/MSSQL.
export const ordGroupByDateFormatQuery = analyzeQuery(
  `
    query getOrderSummary {
      orders: dbo_orders_aggregate(groupBy: [created_at]) {
        key {
          created_at @dateFormat(format: "dd/MM/yyyy")
        }
        count
        items {
          order_id
          total_amount @multiply(by: 100)
        }
      }
    }
  `,
  StoreMSSQL,
);

// Aggregate with a directive that works on every engine (used to prove key/items
// directive application on MySQL, where @dateFormat is unsupported).
export const ordGroupByMultiplyQuery = analyzeQuery(
  `
    query getOrderSummary {
      orders: dbo_orders_aggregate(groupBy: [customer_id]) {
        key {
          customer_id @multiply(by: 100)
        }
        count
        items {
          order_id
          total_amount @multiply(by: 100)
        }
      }
    }
  `,
  StoreMSSQL,
);

// ============================================================================
// Directive Queries
// These test GraphQL @skip and @include directives behavior
// Note: @skip(if: true) ≈ @include(if: false) and @skip(if: false) ≈ @include(if: true)
// ============================================================================

// Skip directive: if true, field is excluded
export const ordWithSkipTrueDirectiveQuery = analyzeQuery(
  `
    {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @skip(if: true) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

export const ordWithSkipFalseDirectiveQuery = analyzeQuery(
  `
    {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @skip(if: false) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

// Include directive: if true, field is included
export const ordWithIncludeTrueDirectiveQuery = analyzeQuery(
  `
    {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @include(if: true) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

export const ordWithIncludeFalseDirectiveQuery = analyzeQuery(
  `
    {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @include(if: false) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

// Variable-based directives for dynamic query behavior
export const ordDirectiveOptionalQuery = analyzeQuery(
  `
    query Orders($val: Boolean = false) {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @include(if: $val) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

export const ordDirectiveRequiredQuery = analyzeQuery(
  `
    query Orders($val: Boolean!) {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @include(if: $val) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

// ============================================================================
// @when Directive Queries
// ============================================================================

// @when(and:) with variables - both true should include the field
export const ordWithWhenAndDirectiveQuery = analyzeQuery(
  `
    query Orders($isAdmin: Boolean!, $showDetails: Boolean!) {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @when(and: [$isAdmin, $showDetails]) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

// @when(or:) with variables - any true should include the field
export const ordWithWhenOrDirectiveQuery = analyzeQuery(
  `
    query Orders($flagA: Boolean!, $flagB: Boolean!) {
      dbo_orders {
        order_id
        customer_id
        dbo_customers @when(or: [$flagA, $flagB]) {
          first_name
        }
      }
    }
  `,
  StoreMSSQL,
);

// ============================================================================
// Directive Queries
// ============================================================================

export const prodWithUppercaseDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @uppercase
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithLowercaseDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @lowercase
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithTruncateDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @truncate(length: 10)
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithDefaultDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @default(value: "Unknown")
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithTrimDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @trim
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithSubstringDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        sku @substring(start: 1, length: 5)
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithReplaceDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @replace(find: " ", replaceWith: "_")
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithConcatDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        sku @concat(with: "-PROD")
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithPadDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id @pad(length: 8, char: "0", side: "left")
        name
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithRoundDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @round(decimals: 2)
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithCeilDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @ceil
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithFloorDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @floor
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithAbsDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @abs
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithMultiplyDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @multiply(by: 1.15)
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithDivideDirectiveQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @divide(by: 2)
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithChainedDirectivesQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        name @trim @uppercase @truncate(length: 15)
        sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodWithMathChainDirectivesQuery = analyzeQuery(
  `
    {
      dbo_products {
        product_id
        price @multiply(by: 1.2) @round(decimals: 2)
      }
    }
  `,
  StoreMSSQL,
);

export const prodWhereArgumentVariableQuery = analyzeQuery(
  `
    query Products($productName: String!) {
      dbo_products(where: { name: { eq: $productName } }) {
        product_id
        name
        sku
        dbo_product_categories {
          category_id
          dbo_categories {
            name
          }
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodWhereArgumentVariableAndStaticQuery = analyzeQuery(
  `
    query Products($productName: String!) {
      dbo_products(where: { name: { eq: $productName }, is_active: { eq: 1 } }) {
        product_id
        name
        sku
        dbo_product_categories {
          category_id
          dbo_categories {
            name
          }
        }
      }
    }
  `,
  StoreMSSQL,
);

export const prodReservedWordAliasQuery = analyzeQuery(
  `
    {
      order: dbo_products {
        print: name
        group: sku
      }
    }
  `,
  StoreMSSQL,
);

export const prodReservedWordColumnQuery = analyzeQuery(
  `
    {
      dbo_products(orderBy: [{ order: ASC }]) {
        order
        name
      }
    }
  `,
  StoreMSSQL,
);

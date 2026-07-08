import { DatabaseStructureZod } from "../../types/zod/db";
import { createMockMSSQL, createMockMySQL, createMockPG } from "../common";

export const structure = DatabaseStructureZod.parse({
  tables: [
    {
      schema: "dbo",
      name: "addresses",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "address_id", dataType: "int", isNullable: false },
        { name: "customer_id", dataType: "int", isNullable: false },
        { name: "line1", dataType: "nvarchar", isNullable: true },
        { name: "line2", dataType: "nvarchar", isNullable: true },
        { name: "city", dataType: "nvarchar", isNullable: true },
        { name: "postal_code", dataType: "nvarchar", isNullable: true },
        { name: "country", dataType: "nvarchar", isNullable: true },
        { name: "is_default", dataType: "bit", isNullable: true },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "customers",
          columns: [{ source: "customer_id", target: "customer_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "categories",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "category_id", dataType: "int", isNullable: false },
        { name: "name", dataType: "nvarchar", isNullable: false },
        { name: "slug", dataType: "nvarchar", isNullable: false },
        { name: "parent_category_id", dataType: "int", isNullable: true },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "categories",
          columns: [{ source: "parent_category_id", target: "category_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "customers",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "customer_id", dataType: "int", isNullable: false },
        { name: "email", dataType: "nvarchar", isNullable: false },
        { name: "first_name", dataType: "nvarchar", isNullable: true },
        { name: "last_name", dataType: "nvarchar", isNullable: true },
        { name: "created_at", dataType: "datetime2", isNullable: false },
        { name: "status", dataType: "nvarchar", isNullable: true },
      ],
      foreignKeys: [],
    },
    {
      schema: "dbo",
      name: "order_items",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "order_item_id", dataType: "int", isNullable: false },
        { name: "order_id", dataType: "int", isNullable: false },
        { name: "product_id", dataType: "int", isNullable: false },
        { name: "quantity", dataType: "int", isNullable: false },
        { name: "unit_price", dataType: "decimal", isNullable: false },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "orders",
          columns: [{ source: "order_id", target: "order_id" }],
        },
        {
          schema: "dbo",
          name: "products",
          columns: [{ source: "product_id", target: "product_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "orders",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "order_id", dataType: "int", isNullable: false },
        { name: "customer_id", dataType: "int", isNullable: false },
        { name: "billing_address_id", dataType: "int", isNullable: true },
        { name: "shipping_address_id", dataType: "int", isNullable: true },
        { name: "status_id", dataType: "int", isNullable: false },
        { name: "total_amount", dataType: "decimal", isNullable: false },
        { name: "created_at", dataType: "datetime2", isNullable: false },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "customers",
          columns: [{ source: "customer_id", target: "customer_id" }],
        },
        {
          schema: "dbo",
          name: "addresses",
          columns: [{ source: "billing_address_id", target: "address_id" }],
        },
        {
          schema: "dbo",
          name: "addresses",
          columns: [{ source: "shipping_address_id", target: "address_id" }],
        },
        {
          schema: "dbo",
          name: "statuses",
          columns: [{ source: "status_id", target: "status_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "payments",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "payment_id", dataType: "int", isNullable: false },
        { name: "order_id", dataType: "int", isNullable: false },
        { name: "amount", dataType: "decimal", isNullable: false },
        { name: "method", dataType: "nvarchar", isNullable: true },
        { name: "status_id", dataType: "int", isNullable: false },
        { name: "paid_at", dataType: "datetime2", isNullable: true },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "orders",
          columns: [{ source: "order_id", target: "order_id" }],
        },
        {
          schema: "dbo",
          name: "statuses",
          columns: [{ source: "status_id", target: "status_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "product_categories",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "product_id", dataType: "int", isNullable: false },
        { name: "category_id", dataType: "int", isNullable: false },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "products",
          columns: [{ source: "product_id", target: "product_id" }],
        },
        {
          schema: "dbo",
          name: "categories",
          columns: [{ source: "category_id", target: "category_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "product_tags",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "product_id", dataType: "int", isNullable: false },
        { name: "tag_id", dataType: "int", isNullable: false },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "products",
          columns: [{ source: "product_id", target: "product_id" }],
        },
        {
          schema: "dbo",
          name: "tags",
          columns: [{ source: "tag_id", target: "tag_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "products",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "product_id", dataType: "int", isNullable: false },
        { name: "sku", dataType: "nvarchar", isNullable: false },
        { name: "name", dataType: "nvarchar", isNullable: false },
        { name: "description", dataType: "nvarchar", isNullable: true },
        { name: "price", dataType: "decimal", isNullable: false },
        { name: "json_attributes", dataType: "nvarchar", isNullable: true },
        { name: "created_at", dataType: "datetime2", isNullable: false },
        { name: "is_active", dataType: "bit", isNullable: true },
      ],
      foreignKeys: [],
    },
    {
      schema: "dbo",
      name: "reviews",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "review_id", dataType: "int", isNullable: false },
        { name: "product_id", dataType: "int", isNullable: false },
        { name: "customer_id", dataType: "int", isNullable: false },
        { name: "rating", dataType: "tinyint", isNullable: false },
        { name: "title", dataType: "nvarchar", isNullable: true },
        { name: "body", dataType: "nvarchar", isNullable: true },
        { name: "created_at", dataType: "datetime2", isNullable: false },
      ],
      foreignKeys: [
        {
          schema: "dbo",
          name: "products",
          columns: [{ source: "product_id", target: "product_id" }],
        },
        {
          schema: "dbo",
          name: "customers",
          columns: [{ source: "customer_id", target: "customer_id" }],
        },
      ],
    },
    {
      schema: "dbo",
      name: "statuses",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "status_id", dataType: "int", isNullable: false },
        { name: "scope", dataType: "nvarchar", isNullable: false },
        { name: "code", dataType: "nvarchar", isNullable: false },
        { name: "name", dataType: "nvarchar", isNullable: true },
        { name: "description", dataType: "nvarchar", isNullable: true },
        { name: "sort_order", dataType: "int", isNullable: true },
      ],
      foreignKeys: [],
    },
    {
      schema: "dbo",
      name: "tags",
      entityType: "table",
      tableDescription: null,
      columns: [
        { name: "tag_id", dataType: "int", isNullable: false },
        { name: "name", dataType: "nvarchar", isNullable: false },
      ],
      foreignKeys: [],
    },
    {
      schema: "dbo",
      name: "view_customer_orders",
      entityType: "view",
      tableDescription: null,
      columns: [
        { name: "customer_id", dataType: "int", isNullable: false },
        { name: "email", dataType: "nvarchar", isNullable: false },
        { name: "orders_count", dataType: "int", isNullable: true },
        { name: "total_spent", dataType: "decimal", isNullable: true },
        { name: "last_order_date", dataType: "datetime2", isNullable: true },
      ],
      foreignKeys: [],
    },
    {
      schema: "dbo",
      name: "view_order_summary",
      entityType: "view",
      tableDescription: null,
      columns: [
        { name: "order_id", dataType: "int", isNullable: false },
        { name: "customer_id", dataType: "int", isNullable: false },
        { name: "created_at", dataType: "datetime2", isNullable: false },
        { name: "order_status_code", dataType: "nvarchar", isNullable: true },
        { name: "order_status_name", dataType: "nvarchar", isNullable: true },
        { name: "item_count", dataType: "int", isNullable: true },
        { name: "computed_total", dataType: "decimal", isNullable: true },
        { name: "stored_total", dataType: "decimal", isNullable: false },
      ],
      foreignKeys: [],
    },
    {
      schema: "dbo",
      name: "view_product_catalog",
      entityType: "view",
      tableDescription: null,
      columns: [
        { name: "product_id", dataType: "int", isNullable: false },
        { name: "sku", dataType: "nvarchar", isNullable: false },
        { name: "name", dataType: "nvarchar", isNullable: false },
        { name: "description", dataType: "nvarchar", isNullable: true },
        { name: "price", dataType: "decimal", isNullable: false },
        { name: "json_attributes", dataType: "nvarchar", isNullable: true },
        { name: "categories", dataType: "nvarchar", isNullable: true },
        { name: "avg_rating", dataType: "decimal", isNullable: true },
      ],
      foreignKeys: [],
    },
  ],
});

export const StoreMSSQL = createMockMSSQL(structure);
export const StorePG = createMockPG(structure);
export const StoreMySQL = createMockMySQL(structure);

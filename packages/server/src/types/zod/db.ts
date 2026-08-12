import { z } from "zod";

import {
  BunSQLConnectionOptionsZod,
  DatabaseConnectionZod,
  DatabaseSchemaConfigZod,
  MSSQLConnectionOptionsZod,
  TableRelationshipZod as TableRelationshipBaseZod,
} from "../../config";
import { genResolverName } from "../../databases/transformers/genResolverName";

// Re-export base types and schemas from the config module
export type {
  BunSQLConnectionOptions,
  DatabaseConfig,
  DatabaseConnection,
  DatabaseSchemaConfig,
  DatabaseType,
  MSSQLConnectionOptions,
  TableRelationship,
  TableSchemaConfig,
} from "../../config";

export {
  BunSQLConnectionOptionsZod,
  DatabaseConnectionZod,
  DatabaseSchemaConfigZod,
  MSSQLConnectionOptionsZod,
  VirtualColumnZod,
} from "../../config";

/**
 * Base column schema from database queries.
 * Handles the isNullable type conversion (number to boolean) that different databases return.
 */
export const TableColumnZod = z
  .object({
    name: z.string(),
    dataType: z.string(),
    isNullable: z.union([z.boolean(), z.number()]),
    description: z.string().nullable().optional(),
  })
  .transform((val) => ({
    name: val.name,
    dataType: val.dataType,
    isNullable: typeof val.isNullable === "boolean" ? val.isNullable : val.isNullable === 1,
    description: val.description ?? null,
  }));

/**
 * Table relationship schema with computed dashedName property.
 * Extends the base config schema with a dashedName transform for introspection use.
 */
export const TableRelationshipEnhancedZod = TableRelationshipBaseZod.transform((rel) => ({
  ...rel,
  dashedName: `${rel.schema}_${rel.name}`,
}));

/**
 * Base table schema from database queries (before enhancement).
 * Contains raw database structure.
 */
export const TableBaseZod = z.object({
  schema: z.string(),
  name: z.string(),
  entityType: z.union([z.literal("table"), z.literal("view")]),
  tableDescription: z.string().nullable().optional(),
  columns: z.array(TableColumnZod),
  foreignKeys: z.array(TableRelationshipEnhancedZod),
});

/**
 * Enrichment function that adds computed properties to tables.
 * Called during Zod transformation.
 */
export const enrichTable = (table: z.output<typeof TableBaseZod>) => ({
  ...table,
  dashedName: `${table.schema}_${table.name}`,
  dashedNameLS: `${table.schema}_${table.name}`.toLowerCase(),
  dottedName: `${table.schema}.${table.name}`,
  dottedQuotedName: `"${table.schema}"."${table.name}"`,
  schemaName: genResolverName(table.schema, table.name, table.entityType),
});

/**
 * Table schema with enriched properties (dashedName, dottedName, etc.).
 * This is the primary table type used throughout the application.
 */
export const TableZod = TableBaseZod.transform(enrichTable);

/**
 * Stored procedure parameter schema.
 */
export const StoredProcedureParameterZod = z.object({
  name: z.string(),
  dataType: z.string().nullable(),
  maxLength: z.number(),
  precision: z.number(),
  scale: z.number(),
});

/**
 * Base stored procedure schema from database queries (before enhancement).
 * Contains raw database structure.
 */
export const StoredProcedureBaseZod = z.object({
  schema: z.string(),
  name: z.string(),
  signature: z.string().optional(),
  type: z.string().optional(),
  parameters: z.array(StoredProcedureParameterZod),
});

/**
 * Stored procedure schema with enriched naming properties.
 * Adds dashedName, dottedName, and other computed fields for consistent naming across the app.
 * Uses signature for unique identification when function overloading exists.
 */
export const StoredProcedureZod = StoredProcedureBaseZod.transform((sp) => {
  const signatureSuffix = sp.signature ? `_${sp.signature.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
  const signatureSuffixClean = signatureSuffix.replace(/_+/g, "_").replace(/_$/, "");
  return {
    ...sp,
    dashedName: `${sp.schema}_${sp.name}${signatureSuffixClean}`,
    dashedNameLS: `${sp.schema}_${sp.name}${signatureSuffixClean}`.toLowerCase(),
    dottedName: `${sp.schema}.${sp.name}`,
    dottedQuotedName: `"${sp.schema}"."${sp.name}"`,
    schemaName: genResolverName(sp.schema, sp.name + signatureSuffixClean, "sp"),
  };
});

/**
 * Database structure schema returned from database queries.
 * Contains both tables and stored procedures with their enriched properties.
 */
export const DatabaseStructureZod = z.object({
  tables: z.array(TableZod).default([]),
  storedProcedures: z.array(StoredProcedureZod).default([]),
});

// View schema
export const ViewZod = z.object({
  schema: z.string(),
  name: z.string(),
  definition: z.string(),
});

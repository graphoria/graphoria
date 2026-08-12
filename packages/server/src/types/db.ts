import { z } from "zod";

import type {
  buildProcedureResolver,
  buildRelationshipResolver,
  buildTableResolver,
} from "../databases";
import type { TableFilter, VirtualColumn } from "./configuration";

import {
  DatabaseStructureZod,
  StoredProcedureBaseZod,
  StoredProcedureZod,
  TableBaseZod,
  TableColumnZod,
  TableZod,
  ViewZod,
  VirtualColumnZod,
} from "./zod/db";

// Re-export VirtualColumnType from the config module
export type { VirtualColumnType } from "../config";

/**
 * TYPE HIERARCHY:
 *
 * 1. BASE TYPES (from database):
 *    - TableColumn: Raw column from DB (with isNullable transformed)
 *    - VirtualColumn: Column from configuration (with virtual/function/expression properties)
 *    - TableBase: Raw table structure
 *    - StoredProcedureBase: Raw stored procedure structure
 *
 * 2. ENRICHED TYPES (with computed properties):
 *    - Table: Base table + dashedName, dottedName, schemaName, etc.
 *    - StoredProcedure: Base SP + dashedName, dottedName, schemaName, etc.
 *
 * 3. RESOLVER TYPES (with database reference & resolver info):
 *    - TableResolver: Table + db, internalName, resolverName, relationships
 *      Note: columns can be TableColumn[] | VirtualColumn[] depending on configuration
 *    - ProcedureResolver: StoredProcedure + db, internalName, resolverName
 *    - RelationshipResolver: Relationship with full resolver naming
 */

// Base types from database (raw structure)
export type TableColumn = z.output<typeof TableColumnZod>;
export type TableBase = z.output<typeof TableBaseZod>;
export type StoredProcedureBase = z.output<typeof StoredProcedureBaseZod>;

// Column type that can be either base or virtual
export type Column = TableColumn | VirtualColumn;

// Enriched types (with computed naming properties from Zod transforms)
export type Table = z.infer<typeof TableZod>;
export type StoredProcedure = z.infer<typeof StoredProcedureZod>;

// Resolver types (with database references and full application context)
// Note: These come from runtime functions since they depend on cross-table relationships
export type RelationshipResolver = ReturnType<typeof buildRelationshipResolver>;
type _TableResolver = ReturnType<typeof buildTableResolver>;

// Override columns to allow both TableColumn and VirtualColumn
export type TableResolver = Omit<_TableResolver, "columns"> & {
  columns: Column[];
  rolePermission?: TableFilter;
};

export type ProcedureResolver = ReturnType<typeof buildProcedureResolver>;

// Database structure types
export type DatabaseStructure = z.infer<typeof DatabaseStructureZod>;
export type Tables = DatabaseStructure["tables"];
export type StoredProcedures = DatabaseStructure["storedProcedures"];

// Utility types
export type View = z.infer<typeof ViewZod>;

// Re-export Zod schemas for validation purposes
export {
  DatabaseStructureZod,
  StoredProcedureBaseZod,
  StoredProcedureZod,
  TableBaseZod,
  TableColumnZod,
  TableZod,
  VirtualColumnZod,
  ViewZod,
} from "./zod/db";

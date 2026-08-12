import { z } from "zod";

// ============================================================================
// Base Zod Schemas for Auth Configuration
// ============================================================================
// These are the pre-transform base schemas — the single source of truth for
// auth config authoring types. The permissions-dictionary normalization
// transform stays in types/zod/auth.ts.

// ============================================================================
// Shared Primitives
// ============================================================================

/**
 * Direction for ORDER BY clause
 */
export const DirectionUnionZod = z.enum([
  "ASC",
  "DESC",
  "ASC_NULLS_FIRST",
  "ASC_NULLS_LAST",
  "DESC_NULLS_FIRST",
  "DESC_NULLS_LAST",
]);

export type DirectionUnion = z.input<typeof DirectionUnionZod>;

/**
 * Order by clause for role-based default ordering
 */
export const OrderByClauseZod = z.strictObject({
  column: z.string(),
  direction: DirectionUnionZod,
});

export type OrderByClause = z.input<typeof OrderByClauseZod>;

/**
 * Every operator the query builder implements. `databases/common.ts` imports this
 * list rather than keeping its own: an operator that exists in one place and not
 * the other is how a role filter ends up matching every row.
 */
export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "in",
  "between",
  "is_null",
  "is_not_null",
  "not_null",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Filter condition — matches GraphQL where argument structure.
 *
 * A value is either a column filter (`{ eq: … }`) or a nested relation filter
 * holding more of the same. Operators are constrained to the implemented set so
 * a typo fails at boot instead of evaluating to no condition, which would hand
 * the role the whole table.
 */
export const FilterConditionZod: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.record(
    z.string(),
    z.union([z.record(z.enum(FILTER_OPERATORS), z.unknown()), FilterConditionZod]),
  ),
);

export type FilterCondition = z.input<typeof FilterConditionZod>;

// ============================================================================
// Permission Schemas
// ============================================================================

/**
 * Table-level permission configuration
 */
export const TablePermissionZod = z.strictObject({
  /** Allowed columns — "ALL" or array of column names */
  columns: z.union([z.literal("ALL"), z.array(z.string())]),
  /** Role-based query filtering (WHERE clause) */
  filter: FilterConditionZod.optional(),
  /** Role-based default ordering (ORDER BY clause) */
  orderBy: z.array(OrderByClauseZod).optional(),
});

export type TablePermission = z.input<typeof TablePermissionZod>;

/**
 * Permission configuration for a role
 */
export const RolePermissionZod = z
  .strictObject({
    /** Tables accessible by this role */
    tables: z
      .union([
        z.array(z.string()),
        z.literal("ALL"),
        z.record(z.string(), z.union([z.literal("ALL"), TablePermissionZod])),
      ])
      .optional()
      .default([]),
    /** Stored procedures accessible by this role */
    storedProcedures: z
      .union([z.array(z.string()), z.literal("ALL")])
      .optional()
      .default([]),
    /** Queues accessible by this role */
    queues: z
      .union([z.array(z.string()), z.literal("ALL")])
      .optional()
      .default([]),
    /** Operations accessible by this role */
    operations: z
      .union([z.array(z.string()), z.literal("ALL")])
      .optional()
      .default([]),
    /** Remote schemas accessible by this role */
    remoteSchemas: z
      .union([z.array(z.string()), z.literal("ALL")])
      .optional()
      .default([]),
    /** Remote REST APIs accessible by this role */
    remoteREST: z
      .union([z.array(z.string()), z.literal("ALL")])
      .optional()
      .default([]),
  })
  .default({
    tables: [],
    storedProcedures: [],
    queues: [],
    operations: [],
    remoteSchemas: [],
    remoteREST: [],
  });

export type RolePermission = z.input<typeof RolePermissionZod>;

// ============================================================================
// Auth Config Schema
// ============================================================================

/**
 * Authentication configuration
 */
export const AuthConfigZod = z
  .strictObject({
    /** Whether authentication is enabled */
    enabled: z.boolean(),
    /** Database name where auth tables are stored */
    database: z.string(),
    /** Schema name for auth tables (default: "auth") */
    schema: z.string().optional().default("auth"),
    /**
     * Whether Graphoria should run CREATE SCHEMA / TABLE IF NOT EXISTS for the
     * auth user table on every boot. Default: false.
     */
    autoCreateTables: z.boolean().optional().default(false),
    /** Permissions per role */
    permissions: z.record(z.string(), RolePermissionZod).optional().default({}),
  })
  .optional()
  .default({
    enabled: false,
    database: "",
    schema: "auth",
    autoCreateTables: false,
    permissions: {},
  });

export type AuthConfig = z.input<typeof AuthConfigZod>;

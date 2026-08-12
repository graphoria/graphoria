import { z } from "zod";

/**
 * Virtual column schema for computed/virtual columns in database schema
 */
export const VirtualColumnZod = z.object({
  name: z.string(),
  dataType: z.string(),
  isNullable: z.boolean(),
  description: z.string().nullable().default(null),
  virtual: z.boolean().optional(),
  function: z.string().optional(),
  params: z.array(z.string()).optional(),
  expression: z.string().optional(),
});

/**
 * Virtual column type definition for computed/virtual columns in database schema
 */
export type VirtualColumnType = z.input<typeof VirtualColumnZod>;

/**
 * Creates a virtual column definition based on a database function
 *
 * @param name - Name of the virtual column
 * @param dataType - SQL data type
 * @param isNullable - Whether the column can be null
 * @param functionName - Database function to call
 * @param params - Parameters to pass to the function (column names or literals)
 *
 * @example
 * ```ts
 * virtualColumnFunction(
 *   "formatted_date",
 *   "varchar",
 *   true,
 *   "dbo.FormatDate",
 *   ["RACE_DATE"]
 * )
 * ```
 */
export type VirtualColumnFunctionFn = (
  name: string,
  dataType: string,
  isNullable: boolean,
  functionName: string,
  params?: string[],
) => VirtualColumnType;

/**
 * Creates a virtual column definition based on a SQL expression
 *
 * @param name - Name of the virtual column
 * @param dataType - SQL data type
 * @param isNullable - Whether the column can be null
 * @param expression - SQL expression for the computed column
 *
 * @example
 * ```ts
 * virtualColumnExpression(
 *   "is_final",
 *   "bit",
 *   true,
 *   `CASE WHEN ROUND = 'f' THEN 1 ELSE 0 END`
 * )
 * ```
 */
export type VirtualColumnExpressionFn = (
  name: string,
  dataType: string,
  isNullable: boolean,
  expression: string,
) => VirtualColumnType;

/**
 * Creates a boolean virtual column for MSSQL Y/N values
 *
 * @param columnName - Source column name containing Y/N values
 * @returns Virtual column that converts Y to true, N to false
 *
 * @example
 * ```ts
 * createYAndNToBooleanMSSQL("IN_PROGRESS")
 * // Creates: IN_PROGRESS_boolean with CASE WHEN IN_PROGRESS = 'Y' THEN 1...
 * ```
 */
export type CreateYAndNToBooleanMSSQLFn = (columnName: string) => VirtualColumnType;

/**
 * Creates a boolean virtual column for MSSQL 1/0 values
 *
 * @param columnName - Source column name containing 1/0 values
 * @returns Virtual column that converts 1 to true, 0 to false
 *
 * @example
 * ```ts
 * createOneToBooleanMSSQL("IS_ACTIVE")
 * // Creates: IS_ACTIVE_boolean with CASE WHEN IS_ACTIVE = 1 THEN 1...
 * ```
 */
export type CreateOneToBooleanMSSQLFn = (columnName: string) => VirtualColumnType;

// ============================================================================
// Runtime helpers
// ============================================================================

export const virtualColumnFunction: VirtualColumnFunctionFn = (
  name,
  dataType,
  isNullable,
  functionName,
  params,
) => ({
  virtual: true,
  isNullable,
  dataType,
  name,
  function: functionName,
  params,
});

export const virtualColumnExpression: VirtualColumnExpressionFn = (
  name,
  dataType,
  isNullable,
  expression,
) => ({
  virtual: true,
  isNullable,
  dataType,
  name,
  expression,
});

export const createYAndNToBooleanMSSQL: CreateYAndNToBooleanMSSQLFn = (columnName) =>
  virtualColumnExpression(
    `${columnName}_boolean`,
    "bit",
    true,
    `CASE
    WHEN ${columnName} = 'Y' THEN CAST(1 AS BIT)
    WHEN ${columnName} = 'N' THEN CAST(0 AS BIT)
    ELSE NULL
  END`,
  );

export const createOneToBooleanMSSQL: CreateOneToBooleanMSSQLFn = (columnName) =>
  virtualColumnExpression(
    `${columnName}_boolean`,
    "bit",
    true,
    `CASE
    WHEN ${columnName} = 1 THEN CAST(1 AS BIT)
    WHEN ${columnName} = 0 THEN CAST(0 AS BIT)
    ELSE NULL
  END`,
  );

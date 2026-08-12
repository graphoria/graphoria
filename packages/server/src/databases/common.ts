import { isBoolean, isString } from "es-toolkit/compat";

import type { SelectionAnalysis, VariableDefinition } from "../analyzeQuery/types";
import type { MergedEntities } from "../configuration/getSchemas/mergeEntities";
import type { DatabaseType, RelationshipCondition, VirtualColumn } from "../types/configuration";

import { applyDirectives } from "./directives";

// Common aggregation types
export interface AggregationField {
  name: string;
  fieldName: string;
  fieldAlias: string;
  alias: string;
  nameResolved: string;
}

export interface GroupByInfo {
  groupByFields: string[];
  aggregations: AggregationField[];
  hasItems: boolean;
  keyResolved: string;
  hasKey: boolean;
  keys: SelectionAnalysis[];
  cteAlias: string;
}

const isOperatorObject = (obj: object): boolean =>
  Object.keys(obj).some((key) =>
    ["eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "is_null", "is_not_null"].includes(key),
  );

export const generateTableAlias = (level: number): string => `t${level}`;

const mappingDbTypeCharVar: Record<DatabaseType, string> = {
  pg: "$",
  mysql: "$",
  mssql: "@",
};

export const buildConditions = (
  entities: MergedEntities,
  dbType: DatabaseType,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown> = {},
  whereArgs: object | unknown | null,
  tableAlias: string,
  level: number,
  aliasMap: { [alias: string]: string },
): string => {
  if (!whereArgs) return "";

  const conditions: string[] = [];

  const whereArg: Record<string, object> = resolveVariable(whereArgs, variables);

  for (const [fieldName, value] of Object.entries(whereArg)) {
    if (isOperatorObject(value)) {
      for (const [operator, operand] of Object.entries(value)) {
        // All values are now variable references (e.g., "$varName" or ["$var1", "$var2"])
        const resolvedValue = Array.isArray(operand)
          ? operand.map((op) => {
              if (isString(op) && op.startsWith("$")) {
                const index = variablesDefinition.findIndex((v) => v.name === op.substring(1));
                return `${mappingDbTypeCharVar[dbType]}${index + 1}`;
              }
              return op;
            })
          : isString(operand) && operand.startsWith("$")
            ? `${mappingDbTypeCharVar[dbType]}${variablesDefinition.findIndex((v) => v.name === operand.substring(1)) + 1}`
            : operand;

        const condition = buildCondition(tableAlias, fieldName, operator, resolvedValue, dbType);

        if (condition) {
          conditions.push(condition);
        }
      }
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const nestedTableAlias = `t${level}`;

      const parentTableName = aliasMap[tableAlias];

      const joinCondition = findJoinCondition(
        entities,
        parentTableName,
        fieldName,
        tableAlias,
        nestedTableAlias,
        dbType,
      );

      const nestedConditions = buildConditions(
        entities,
        dbType,
        variablesDefinition,
        variables,
        value,
        nestedTableAlias,
        level + 1,
        aliasMap,
      );

      const existsClause = `EXISTS (
      SELECT 1
      FROM ${entities.queriesMap[fieldName]!.dottedQuotedName} ${nestedTableAlias}
      WHERE ${joinCondition}${nestedConditions ? ` AND (${nestedConditions})` : ""}
    )`;

      conditions.push(existsClause);
    }
  }

  return conditions.length > 0 ? conditions.join(" AND ") : "";
};

// Reserved words (e.g. PRINT, ORDER) are valid GraphQL names; always delimit
// identifiers so they parse as identifiers in every dialect.
const identifierDelimiters: Record<DatabaseType, [string, string]> = {
  pg: ['"', '"'],
  mysql: ["`", "`"],
  mssql: ["[", "]"],
};

export const wrapIdentifierFp =
  (dbType: DatabaseType) =>
  (value: string): string => {
    const [open, close] = identifierDelimiters[dbType];
    // Doubling the closing delimiter is the escape in all three dialects; only
    // introspected names can contain one (GraphQL names never do).
    return `${open}${value.replaceAll(close, `${close}${close}`)}${close}`;
  };

export const wrapIdentifierPG = wrapIdentifierFp("pg");
export const wrapIdentifierMSSQL = wrapIdentifierFp("mssql");
export const wrapIdentifierMySQL = wrapIdentifierFp("mysql");

export const qualifiedNameFp =
  (dbType: DatabaseType) =>
  ({ schema, name }: { schema: string; name: string }): string => {
    const wrap = wrapIdentifierFp(dbType);
    return `${wrap(schema)}.${wrap(name)}`;
  };

// Helper to resolve variable values
const resolveVariable = <T>(value: unknown, variables: Record<string, unknown>): T => {
  if (isString(value) && value.startsWith("$")) {
    return variables[value.substring(1)] as T;
  }
  return value as T;
};

const buildCondition = (
  tableAlias: string,
  field: string,
  operator: string,
  value: unknown,
  dbType: DatabaseType,
): string | null => {
  const wrappedField = wrapIdentifierFp(dbType)(field);

  switch (operator) {
    case "eq":
      return `${tableAlias}.${wrappedField} = ${value}`;
    case "neq":
      return `${tableAlias}.${wrappedField} <> ${value}`;
    case "gt":
      return `${tableAlias}.${wrappedField} > ${value}`;
    case "gte":
      return `${tableAlias}.${wrappedField} >= ${value}`;
    case "lt":
      return `${tableAlias}.${wrappedField} < ${value}`;
    case "lte":
      return `${tableAlias}.${wrappedField} <= ${value}`;
    case "like":
      return `${tableAlias}.${wrappedField} LIKE ${value}`;
    case "in":
      return `${tableAlias}.${wrappedField} IN (${
        Array.isArray(value) ? value.join(", ") : value
      })`;
    case "is_null":
      return value
        ? `${tableAlias}.${wrappedField} IS NULL`
        : `${tableAlias}.${wrappedField} IS NOT NULL`;
    case "is_not_null":
      return value
        ? `${tableAlias}.${wrappedField} IS NOT NULL`
        : `${tableAlias}.${wrappedField} IS NULL`;
    default:
      return null;
  }
};

const COLLATION_NAME_RE = /^[A-Za-z0-9_]+$/;

// Equating two character columns with different collations raises a hard error (SQL Server:
// "cannot resolve the collation conflict"; MySQL: "illegal mix of collations"). Coerce the right
// operand to a shared collation, but only when both columns carry one and the two differ: a null
// collation marks a non-character column, where COLLATE is itself illegal. Matching or unknown
// collations leave the equality byte-for-byte unchanged (and keep the join column SARGable).
const collateSuffix = (
  dbType: DatabaseType,
  parentCollation: string | null | undefined,
  childCollation: string | null | undefined,
): string => {
  if (!parentCollation || !childCollation || parentCollation === childCollation) return "";

  if (dbType === "mssql") return " COLLATE DATABASE_DEFAULT";
  if (dbType === "pg") return ` COLLATE "default"`;
  // MySQL has no database-default token; coerce to the left column's own collation name.
  return COLLATION_NAME_RE.test(parentCollation) ? ` COLLATE ${parentCollation}` : "";
};

const columnCollation = (
  entities: MergedEntities,
  tableName: string,
  columnName: string,
): string | null | undefined => {
  const column = entities.queriesMap[tableName]?.columns.find((c) => c.name === columnName);
  return column && "collation" in column ? column.collation : undefined;
};

const pairsToAnd = (
  pairs: {
    parentAlias: string;
    childAlias: string;
    parentColumn: string;
    childColumn: string;
    parentCollation?: string | null;
    childCollation?: string | null;
  }[],
  dbType: DatabaseType,
) => {
  const wrap = wrapIdentifierFp(dbType);
  return pairs
    .map(
      (p) =>
        `${p.parentAlias}.${wrap(p.parentColumn)} = ${p.childAlias}.${wrap(p.childColumn)}${collateSuffix(dbType, p.parentCollation, p.childCollation)}`,
    )
    .join(" AND ");
};

const RELATIONSHIP_CONDITION_SQL_OPERATORS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
};

// Static join-condition values are literals (never bound as params at this layer),
// so render them safely: escape quotes in strings, reject non-finite numbers, and
// emit dialect-correct booleans (MSSQL has no boolean type — compare against 1/0).
const sqlLiteral = (dbType: DatabaseType, value: string | number | boolean): string => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Relationship condition value must be a finite number, got ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    if (dbType === "mssql") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  return `'${value.replaceAll("'", "''")}'`;
};

const renderCondition = (
  dbType: DatabaseType,
  alias: string,
  column: string,
  operator: string,
  value: string | number | boolean | undefined,
): string => {
  const target = `${alias}.${wrapIdentifierFp(dbType)(column)}`;

  if (operator === "is_null") return `${target} IS NULL`;
  if (operator === "is_not_null") return `${target} IS NOT NULL`;

  const sqlOperator = RELATIONSHIP_CONDITION_SQL_OPERATORS[operator];
  if (!sqlOperator || value === undefined) {
    throw new Error(`Invalid relationship condition operator "${operator}"`);
  }

  return `${target} ${sqlOperator} ${sqlLiteral(dbType, value)}`;
};

// A condition targets exactly one side of the relationship: `source` (a column on
// the declaring table → fromAlias) or `target` (a column on the referenced table →
// toAlias). The from/to aliases flip between forward and reverse joins.
const conditionsToAnd = (
  conditions: readonly RelationshipCondition[] | undefined,
  fromAlias: string,
  toAlias: string,
  dbType: DatabaseType,
): string =>
  (conditions ?? [])
    .map((c) =>
      c.source !== undefined
        ? renderCondition(dbType, fromAlias, c.source, c.operator ?? "eq", c.value)
        : renderCondition(dbType, toAlias, c.target!, c.operator ?? "eq", c.value),
    )
    .join(" AND ");

const joinParts = (...parts: string[]): string => parts.filter(Boolean).join(" AND ");

export const findJoinCondition = (
  entities: MergedEntities,
  parentTableName: string,
  childTableName: string,
  parentAlias: string,
  childAlias: string,
  dbType: DatabaseType,
): string => {
  const relations = entities.getForeignKeysBetweenTables(parentTableName, childTableName);

  if (!relations.relationships?.length && !relations.relationshipsReversed?.length) return "";

  return [
    ...(relations.relationships?.map((relation) =>
      joinParts(
        pairsToAnd(
          relation.columns.map((c) => ({
            parentAlias,
            childAlias,
            parentColumn: c.source,
            childColumn: c.target,
            parentCollation: columnCollation(entities, parentTableName, c.source),
            childCollation: columnCollation(entities, childTableName, c.target),
          })),
          dbType,
        ),
        conditionsToAnd(relation.conditions, parentAlias, childAlias, dbType),
      ),
    ) ?? []),
    ...(relations.relationshipsReversed?.map((relation) =>
      joinParts(
        pairsToAnd(
          relation.columns.map((c) => ({
            parentAlias,
            childAlias,
            parentColumn: c.target,
            childColumn: c.source,
            parentCollation: columnCollation(entities, parentTableName, c.target),
            childCollation: columnCollation(entities, childTableName, c.source),
          })),
          dbType,
        ),
        conditionsToAnd(relation.conditions, childAlias, parentAlias, dbType),
      ),
    ) ?? []),
  ].join(" AND ");
};

export const buildWhereClauseFp =
  (dbType: DatabaseType = "pg") =>
  (
    entities: MergedEntities,
    variablesDefinition: VariableDefinition[],
    variables: Record<string, unknown>,
    field: SelectionAnalysis,
    tableAlias: string,
    parentTableName: string | null,
    parentTableAlias: string | null,
    level: number,
    aliasMap: { [alias: string]: string },
  ): string => {
    const whereConditions: string[] = [
      buildConditions(
        entities,
        dbType,
        variablesDefinition,
        variables,
        field.arguments?.["where"],
        tableAlias,
        level + 1,
        aliasMap,
      ),
      parentTableName && parentTableAlias
        ? findJoinCondition(
            entities,
            parentTableName,
            field.name,
            parentTableAlias,
            tableAlias,
            dbType,
          )
        : null,
    ].filter(Boolean) as string[];

    return whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";
  };

export const buildWhereClauseMSSQL = buildWhereClauseFp("mssql");
export const buildWhereClausePG = buildWhereClauseFp("pg");
export const buildWhereClauseMySQL = buildWhereClauseFp("mysql");

// Helper function to parse order direction and null handling
const ORDER_DIRECTION_MAP: Record<string, { sort: string; nulls?: string }> = {
  ASC: { sort: "ASC" },
  DESC: { sort: "DESC" },
  ASC_NULLS_FIRST: { sort: "ASC", nulls: "FIRST" },
  ASC_NULLS_LAST: { sort: "ASC", nulls: "LAST" },
  DESC_NULLS_FIRST: { sort: "DESC", nulls: "FIRST" },
  DESC_NULLS_LAST: { sort: "DESC", nulls: "LAST" },
};

const parseOrderDirection = (direction: string): { sort: string; nulls?: string } =>
  ORDER_DIRECTION_MAP[direction] ?? { sort: direction };

export const buildOrderByClauseFp =
  (dbType: DatabaseType = "pg") =>
  (entities: MergedEntities, field: SelectionAnalysis, tableAlias: string): string => {
    const wrap = wrapIdentifierFp(dbType);
    if (field.arguments?.["orderBy"]) {
      const orderBy = field.arguments?.["orderBy"];
      // orderBy is an array or object of { column: direction } - no variable resolution needed
      // since column names are schema-defined and directions are enum values
      const orderByFields = Array.isArray(orderBy) ? orderBy : [orderBy];

      if (entities.queriesMap[field.name]?.rolePermission?.orderBy) {
        orderByFields.push(
          ...(entities.queriesMap[field.name].rolePermission?.orderBy?.map((o) => ({
            [o.column]: o.direction,
          })) ?? []),
        );
      }

      const orderByList = orderByFields
        .map((ob) => {
          const [colName, direction] = Object.entries(ob)[0];
          const { sort, nulls } = parseOrderDirection(direction as string);

          const virtualColumn = entities.isVirtualColumn(field.name, colName);

          if (nulls) {
            if (dbType === "pg") {
              // PostgreSQL supports NULLS FIRST/LAST natively
              return `${tableAlias}.${wrap(colName)} ${sort} NULLS ${nulls}`;
            } else if (dbType === "mysql") {
              // MySQL: Use CASE statement for NULL handling
              const nullFirst = nulls === "FIRST";
              return `CASE WHEN ${tableAlias}.${wrap(colName)} IS NULL THEN ${nullFirst ? 0 : 1} ELSE ${nullFirst ? 1 : 0} END, ${tableAlias}.${wrap(colName)} ${sort}`;
            } else {
              // MSSQL requires CASE statements for NULL handling
              const nullFirst = nulls === "FIRST";
              const isAsc = sort === "ASC";

              if ((nullFirst && isAsc) || (!nullFirst && !isAsc)) {
                // NULLs naturally come first in this combination
                return `${tableAlias}.${wrap(colName)} ${sort}`;
              } else {
                // Need to force NULL positioning with CASE
                return `CASE WHEN ${tableAlias}.${wrap(colName)} IS NULL THEN ${nullFirst ? 0 : 1} ELSE ${nullFirst ? 1 : 0} END, ${tableAlias}.${wrap(colName)} ${sort}`;
              }
            }
          } else {
            // No explicit NULL handling - use database defaults
            if (virtualColumn) {
              const vc = virtualColumn as VirtualColumn;
              return `(
                ${vc.function ? `${vc.function}(${vc.params?.join(", ")})` : `${vc.expression}`}
              ) ${sort}`;
            }

            return `${tableAlias}.${wrap(colName)} ${sort}`;
          }
        })
        .join(", ");

      return `ORDER BY ${orderByList}`;
    }
    return "";
  };

export const buildOrderByClauseMSSQL = buildOrderByClauseFp("mssql");
export const buildOrderByClausePG = buildOrderByClauseFp("pg");
export const buildOrderByClauseMySQL = buildOrderByClauseFp("mysql");

export const filterBasedOnDirective = (
  field: SelectionAnalysis,
  variablesDefinition: VariableDefinition[] = [],
  variables: Record<string, unknown>,
): boolean => {
  if (field.directives?.length) {
    const skipDirective = field.directives.find(
      (d) => d.name === "skip" && d.arguments?.["if"] !== undefined,
    );

    if (skipDirective) {
      const valueOfSkipDirective = skipDirective.arguments?.["if"];

      if (isString(valueOfSkipDirective) && valueOfSkipDirective.startsWith("$")) {
        const variableName = valueOfSkipDirective.substring(1);

        const variableDefinition = variablesDefinition.find((v) => v.name === variableName);

        if (!variableDefinition) {
          throw new Error(`Variable ${variableName} not found`);
        }

        return !(variables[variableName] ?? variableDefinition.defaultValue ?? true);
      } else if (isBoolean(valueOfSkipDirective)) {
        return !valueOfSkipDirective;
      }

      return true;
    }

    const includeDirective = field.directives.find(
      (d) => d.name === "include" && d.arguments?.["if"] !== undefined,
    );

    if (includeDirective) {
      const valueOfIncludeDirective = includeDirective.arguments?.["if"];

      if (isString(valueOfIncludeDirective) && valueOfIncludeDirective.startsWith("$")) {
        const variableName = valueOfIncludeDirective.substring(1);

        const variableDefinition = variablesDefinition.find((v) => v.name === variableName);

        if (!variableDefinition) {
          throw new Error(`Variable ${variableName} not found`);
        }

        return !!(variables[variableName] ?? variableDefinition.defaultValue ?? false);
      } else if (isBoolean(valueOfIncludeDirective)) {
        return valueOfIncludeDirective;
      }

      return false;
    }

    const whenDirective = field.directives.find(
      (d) =>
        d.name === "when" &&
        (d.arguments?.["and"] !== undefined || d.arguments?.["or"] !== undefined),
    );

    if (whenDirective) {
      const andArgs = whenDirective.arguments?.["and"] as unknown[] | undefined;
      const orArgs = whenDirective.arguments?.["or"] as unknown[] | undefined;

      if (andArgs && orArgs) {
        throw new Error('@when directive: "and" and "or" are mutually exclusive');
      }

      const items = andArgs ?? orArgs;
      if (!items || !Array.isArray(items)) {
        return false;
      }

      const resolvedValues = items.map((item) => {
        if (isString(item) && item.startsWith("$")) {
          const variableName = item.substring(1);
          const variableDefinition = variablesDefinition.find((v) => v.name === variableName);

          if (!variableDefinition) {
            throw new Error(`Variable ${variableName} not found`);
          }

          return !!(variables[variableName] ?? variableDefinition.defaultValue ?? false);
        } else if (isBoolean(item)) {
          return item;
        }
        return false;
      });

      return andArgs ? resolvedValues.every(Boolean) : resolvedValues.some(Boolean);
    }

    return true;
  }

  return true;
};

export const processFieldSelectionsFp =
  (dbType: DatabaseType = "pg") =>
  (
    entities: MergedEntities,
    variablesDefinition: VariableDefinition[] = [],
    variables: Record<string, unknown> = {},
    field: SelectionAnalysis,
    tableName: string,
    tableAlias: string,
    level: number,
    buildSubquery: (sel: SelectionAnalysis, level: number) => string,
    selectBuilder: (entry: [name: string, selector: string]) => string,
  ): string => {
    const selectClauses: [string, string][] = [];
    const subQueries: [string, string][] = [];

    field.selections
      ?.filter((f) => filterBasedOnDirective(f, variablesDefinition, variables))
      ?.forEach((sel) => {
        const colName = sel.alias || sel.name;

        if (sel.selections) {
          subQueries.push([`${colName}`, buildSubquery(sel, level + 1)]);
        } else {
          const virtColumn = entities.isVirtualColumn(tableName, sel.name);

          if (virtColumn) {
            // Explicit assertion needed due to Column union type inference
            const vc = virtColumn as VirtualColumn;
            if (vc.function) {
              selectClauses.push([`${colName}`, `${vc.function}(${vc.params?.join(", ")})`]);
            } else if (vc.expression) {
              selectClauses.push([`${colName}`, `(${vc.expression})`]);
            }
          } else {
            let querySelector = `${tableAlias}.${wrapIdentifierFp(dbType)(sel.name)}`;

            // Apply all directives using the handler registry
            querySelector = applyDirectives(
              querySelector,
              sel.directives,
              dbType,
              variablesDefinition,
            );

            selectClauses.push([colName, querySelector]);
          }
        }
      });

    const selectList = [...selectClauses, ...subQueries].map(selectBuilder).join(",\n");

    return selectList;
  };

export const processFieldSelectionsPG = processFieldSelectionsFp("pg");
export const processFieldSelectionsMSSQL = processFieldSelectionsFp("mssql");
export const processFieldSelectionsMySQL = processFieldSelectionsFp("mysql");

// Helper function to check if a field is an aggregation
export const isAggregationField = (fieldName: string): boolean => {
  return ["count", "min", "max", "sum", "avg"].includes(fieldName);
};

// Helper function to extract aggregation info from selections
export const extractAggregationInfo = (
  field: SelectionAnalysis,
  tableAlias: string,
): GroupByInfo | null => {
  const groupBy = field.arguments?.groupBy;
  if (!groupBy || !Array.isArray(groupBy)) {
    return null;
  }

  const aggregations: AggregationField[] = [];
  const keys: SelectionAnalysis[] = [];

  let keyResolved = "";
  let hasItems = false;

  field.selections?.forEach((sel) => {
    if (sel.name === "items") {
      hasItems = true;
    } else if (sel.name === "key") {
      keyResolved = sel.alias || sel.name;

      // If 'key' is selected, we need to include all groupBy fields
      sel.selections?.forEach((keySel) => {
        if (groupBy.includes(keySel.name)) {
          keys.push(keySel);
        }
      });
    } else if (isAggregationField(sel.name)) {
      if (sel.name === "count") {
        aggregations.push({
          name: "count",
          alias: "count",
          fieldName: "*",
          fieldAlias: "*",
          nameResolved: sel.alias || "count",
        });
      } else {
        const fieldSelected = sel.selections?.[0];

        // For min, max, sum, avg - extract the field they're aggregating
        const fieldName = fieldSelected?.name;
        const fieldAlias = fieldSelected?.alias;
        if (fieldName) {
          aggregations.push({
            name: sel.name,
            fieldName,
            fieldAlias: fieldAlias || fieldName,
            alias: `${sel.name}_${fieldName}`,
            nameResolved: sel.alias || sel.name,
          });
        }
      }
    }
  });

  return {
    groupByFields: groupBy,
    aggregations,
    hasItems,
    keyResolved,
    hasKey: keys.length > 0,
    keys,
    cteAlias: `${tableAlias}_agg`,
  };
};

// Helper function to check if a query is for a single item
export const isSingleQuery = (fieldName: string): boolean => fieldName.endsWith("_single");

// Helper to convert variable reference to positional placeholder
const toPositionalPlaceholder = (
  value: unknown,
  variablesDefinition: VariableDefinition[],
  dbType: DatabaseType,
): string | null => {
  if (isString(value) && value.startsWith("$")) {
    const varName = value.substring(1);
    const index = variablesDefinition.findIndex((v) => v.name === varName);
    if (index >= 0) {
      return `${mappingDbTypeCharVar[dbType]}${index + 1}`;
    }
  }
  return null;
};

// Factory function for pagination clause builders
export const buildPaginationClauseFp =
  (dbType: DatabaseType = "pg") =>
  (field: SelectionAnalysis, variablesDefinition: VariableDefinition[] = []): string => {
    const args = field.arguments;

    // MSSQL requires ORDER BY for pagination
    if (
      dbType === "mssql" &&
      (!args || args["limit"] === undefined || args["orderBy"] === undefined)
    ) {
      return "";
    }

    if (!args || args["limit"] === undefined) {
      return "";
    }

    // Convert limit variable reference to positional placeholder
    const limitPlaceholder = toPositionalPlaceholder(args["limit"], variablesDefinition, dbType);
    if (!limitPlaceholder) {
      return ""; // Limit must be a variable reference
    }

    // Convert offset variable reference to positional placeholder (default to 0 if not provided)
    const offsetPlaceholder = args["offset"]
      ? toPositionalPlaceholder(args["offset"], variablesDefinition, dbType)
      : "0";

    // Return database-specific syntax
    return dbType === "mssql"
      ? `OFFSET ${offsetPlaceholder} ROWS FETCH NEXT ${limitPlaceholder} ROWS ONLY`
      : `LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;
  };

export const buildPaginationClausePG = buildPaginationClauseFp("pg");
export const buildPaginationClauseMSSQL = buildPaginationClauseFp("mssql");
export const buildPaginationClauseMySQL = buildPaginationClauseFp("mysql");

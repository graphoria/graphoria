import type {
  OperationAnalysis,
  SelectionAnalysis,
  VariableDefinition,
} from "../../../../analyzeQuery/types";
import type { MergedEntities } from "../../../../configuration/getSchemas/mergeEntities";
import type { GroupByInfo } from "../../../common";

import {
  buildOrderByClauseMSSQL,
  buildPaginationClauseMSSQL,
  buildWhereClauseMSSQL,
  extractAggregationInfo,
  filterBasedOnDirective,
  generateTableAlias,
  isAggregationField,
  isSingleQuery,
  processFieldSelectionsMSSQL,
  sqlColumnName,
  wrapIdentifierMSSQL,
} from "../../../common";

import { applyDirectives } from "../../../directives";

// FOR JSON PATH uses the unbracketed alias as the JSON key, so bracket-quoting
// (required for reserved words like PRINT) never leaks into results.

// Generate CTE for aggregations
const buildAggregationCTE = (
  entities: MergedEntities,
  tableName: string,
  groupByInfo: GroupByInfo,
  dottedQuotedName: string,
  tableAlias: string,
  whereClause: string,
): string => {
  const { groupByFields, aggregations, cteAlias } = groupByInfo;
  const sqlName = (fieldName: string) => sqlColumnName(entities, tableName, fieldName);

  const selectClauses: string[] = [];

  // Add group by fields
  groupByFields.forEach((field) => {
    selectClauses.push(`${tableAlias}.${wrapIdentifierMSSQL(sqlName(field))}`);
  });

  // Add aggregations
  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`COUNT(*) AS ${agg.alias}`);
    } else {
      const func = agg.name.toUpperCase();
      // SQL Server's AVG over an integer column is integer division — AVG of
      // 1, 5, 5, 2 is 3, not 3.25 — so the average has to be taken on a float.
      const operand =
        agg.name === "avg"
          ? `CAST(${tableAlias}.${wrapIdentifierMSSQL(sqlName(agg.fieldName))} AS FLOAT)`
          : `${tableAlias}.${wrapIdentifierMSSQL(sqlName(agg.fieldName))}`;
      selectClauses.push(`${func}(${operand}) AS ${agg.alias}`);
    }
  });

  const groupByClause = `GROUP BY ${groupByFields.map((field) => `${tableAlias}.${wrapIdentifierMSSQL(sqlName(field))}`).join(", ")}`;

  return `${cteAlias} AS (
    SELECT
      ${selectClauses.join(",\n      ")}
    FROM ${dottedQuotedName} ${tableAlias}
    ${whereClause}
    ${groupByClause}
  )`;
};

// Build the main query for grouped results
const buildGroupedQuery = (
  entities: MergedEntities,
  variablesDefinition: VariableDefinition[],
  field: SelectionAnalysis,
  groupByInfo: GroupByInfo,
  dottedQuotedName: string,
  tableAlias: string,
  whereClause: string,
): string => {
  const { groupByFields, aggregations, hasItems, keyResolved, hasKey, keys, cteAlias } =
    groupByInfo;

  const sqlName = (fieldName: string) => sqlColumnName(entities, field.name, fieldName);

  const selectClauses: string[] = [];

  if (hasKey) {
    // Add key object with group by fields
    const keyFields = keys
      .map((key) => {
        const selector = applyDirectives(
          `${cteAlias}.${wrapIdentifierMSSQL(sqlName(key.name))}`,
          key.directives,
          "mssql",
          variablesDefinition,
        );
        return `${selector} AS ${wrapIdentifierMSSQL(key.alias || key.name)}`;
      })
      .join(", ");

    selectClauses.push(
      `JSON_QUERY((SELECT ${keyFields} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS ${wrapIdentifierMSSQL(keyResolved)}`,
    );
  }

  // Add aggregation results
  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`${cteAlias}.${agg.alias} AS ${wrapIdentifierMSSQL(agg.nameResolved)}`);
    } else {
      selectClauses.push(
        `JSON_QUERY((SELECT ${cteAlias}.${agg.alias} AS ${wrapIdentifierMSSQL(agg.fieldAlias)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS ${wrapIdentifierMSSQL(agg.nameResolved)}`,
      );
    }
  });

  // Add items if requested
  if (hasItems) {
    const itemsSelection = field.selections?.find((sel) => sel.name === "items");

    if (itemsSelection?.selections) {
      const itemFields = itemsSelection.selections
        .filter((sel) => !isAggregationField(sel.name) && sel.name !== "items")
        .map((sel) => {
          const selector = applyDirectives(
            `${tableAlias}.${wrapIdentifierMSSQL(sqlName(sel.name))}`,
            sel.directives,
            "mssql",
            variablesDefinition,
          );
          return `${selector} AS ${wrapIdentifierMSSQL(sel.alias || sel.name)}`;
        })
        .join(", ");

      if (itemFields) {
        const joinConditions = groupByFields.map(
          (groupByField) =>
            `${tableAlias}.${wrapIdentifierMSSQL(sqlName(groupByField))} = ${cteAlias}.${wrapIdentifierMSSQL(sqlName(groupByField))}`,
        );

        selectClauses.push(`JSON_QUERY(ISNULL((
          SELECT ${itemFields}
          FROM ${dottedQuotedName} ${tableAlias}
          ${whereClause ? [whereClause, ...joinConditions].join(" AND ") : `WHERE ${joinConditions.join(" AND ")}`}
          FOR JSON PATH, INCLUDE_NULL_VALUES
        ), '[]')) AS ${wrapIdentifierMSSQL(itemsSelection.alias || itemsSelection.name)}`);
      }
    }
  }

  const orderByClause = buildOrderByClauseMSSQL(entities, field, cteAlias);

  return `SELECT ${selectClauses.join(",\n    ")}
    FROM ${cteAlias} ${orderByClause}
    FOR JSON PATH, INCLUDE_NULL_VALUES`;
};

export const generateSQL = (
  entities: MergedEntities,
  operation: OperationAnalysis,
  variables: Record<string, unknown> = {},
  forHashMethod: boolean = false,
): string => {
  if (forHashMethod) {
    return `SELECT HASHBYTES('MD5', (
        ${buildSQLForField(
          entities,
          operation.variables ?? [],
          variables,
          operation.fields[0],
          null,
          null,
          1,
          {},
        )})
    ) AS ResultHash`;
  }

  const variablesWithDefault = {
    ...operation.variables?.reduce<Record<string, unknown>>((acc, variable) => {
      if (variable.defaultValue !== undefined) {
        acc[variable.name] = variable.defaultValue;
      }
      return acc;
    }, {}),
    ...variables,
  };

  // Check if any field requires CTEs (has groupBy)
  const filteredFields = operation.fields?.filter((f) =>
    filterBasedOnDirective(f, operation.variables ?? [], variablesWithDefault),
  );

  const ctes: string[] = [];
  const fieldQueries: string[] = [];

  filteredFields?.forEach((field, index) => {
    const tableAlias = generateTableAlias(index + 1);
    const groupByInfo = extractAggregationInfo(field, tableAlias);

    if (groupByInfo) {
      // This field requires a CTE
      const { dottedQuotedName } = entities.queriesMap[field.name]!;

      const whereClause = buildWhereClauseMSSQL(
        entities,
        operation.variables ?? [],
        variablesWithDefault,
        field,
        tableAlias,
        null,
        null,
        index + 1,
        {},
      );

      const cte = buildAggregationCTE(
        entities,
        field.name,
        groupByInfo,
        dottedQuotedName,
        tableAlias,
        whereClause,
      );
      ctes.push(cte);
    }

    const fieldSQL = buildSQLForField(
      entities,
      operation.variables ?? [],
      variablesWithDefault,
      field,
      null,
      null,
      index + 1,
      {},
    );

    fieldQueries.push(`(${fieldSQL}) as ${wrapIdentifierMSSQL(field.alias || field.name)}`);
  });

  const cteClause = ctes.length > 0 ? `WITH\n${ctes.join(",\n")}\n` : "";

  return `
    ${cteClause}SELECT
      ${fieldQueries.join(",\n")}
    FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER
  `;
};

export const buildSQLForField = (
  entities: MergedEntities,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown> = {},
  field: SelectionAnalysis,
  parentTableName: string | null,
  parentTableAlias: string | null,
  level: number,
  aliasMap: { [alias: string]: string },
): string => {
  const tableAlias = generateTableAlias(level);

  const withoutArrayWrapper = isSingleQuery(field.name);

  const foundTable = entities.queriesMap[field.name];

  if (!foundTable) {
    throw new Error(`Table not found for field: ${field.name}`);
  }

  const { dottedQuotedName, resolverName } = foundTable;

  aliasMap[tableAlias] = resolverName;

  const whereClause = buildWhereClauseMSSQL(
    entities,
    variablesDefinition,
    variables,
    field,
    tableAlias,
    parentTableName,
    parentTableAlias,
    level,
    aliasMap,
  );

  // Check if this is a GROUP BY query
  const groupByInfo = extractAggregationInfo(field, tableAlias);

  if (groupByInfo) {
    // Handle GROUP BY aggregation query
    const mainQuery = buildGroupedQuery(
      entities,
      variablesDefinition,
      field,
      groupByInfo,
      dottedQuotedName,
      tableAlias,
      whereClause,
    );

    return mainQuery;
  }

  // Original logic for non-aggregation queries
  const selectList = processFieldSelectionsMSSQL(
    entities,
    variablesDefinition,
    variables,
    field,
    resolverName,
    tableAlias,
    level,
    (sel, level) =>
      buildSQLForField(
        entities,
        variablesDefinition,
        variables,
        sel,
        resolverName,
        tableAlias,
        level,
        aliasMap,
      ),
    ([name, selector]) => `${selector} AS ${wrapIdentifierMSSQL(name)}`,
  );

  const fromClause = `FROM ${dottedQuotedName} ${tableAlias}`;

  const orderByClause = buildOrderByClauseMSSQL(entities, field, tableAlias);
  const paginationClause = buildPaginationClauseMSSQL(field, variablesDefinition);

  const isArray = field.isArray;
  const forJson =
    isArray && !withoutArrayWrapper
      ? "FOR JSON PATH, INCLUDE_NULL_VALUES"
      : "FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER";

  const baseQuery = `SELECT ${selectList} ${fromClause} ${whereClause} ${orderByClause}${paginationClause ? ` ${paginationClause}` : ""} ${forJson}`;

  if (isArray && !withoutArrayWrapper) {
    return `JSON_QUERY(ISNULL((${baseQuery}), '[]'))`;
  } else {
    return `JSON_QUERY(NULLIF((${baseQuery}), ''))`;
  }
};

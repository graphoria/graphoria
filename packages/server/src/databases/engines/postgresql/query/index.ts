import type {
  OperationAnalysis,
  SelectionAnalysis,
  VariableDefinition,
} from "../../../../analyzeQuery/types";
import type { MergedEntities } from "../../../../configuration/getSchemas/mergeEntities";
import type { GroupByInfo } from "../../../common";

import {
  buildOrderByClausePG,
  buildPaginationClausePG,
  buildWhereClausePG,
  extractAggregationInfo,
  filterBasedOnDirective,
  generateTableAlias,
  isAggregationField,
  isSingleQuery,
  processFieldSelectionsPG,
} from "../../../common";

// Generate CTE for aggregations
const buildAggregationCTE = (
  groupByInfo: GroupByInfo,
  dottedQuotedName: string,
  tableAlias: string,
  whereClause: string,
): string => {
  const { groupByFields, aggregations, cteAlias } = groupByInfo;

  const selectClauses: string[] = [];

  // Add group by fields
  groupByFields.forEach((field) => {
    selectClauses.push(`${tableAlias}."${field}"`);
  });

  // Add aggregations
  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`COUNT(*) AS ${agg.alias}`);
    } else {
      const func = agg.name.toUpperCase();
      selectClauses.push(`${func}(${tableAlias}."${agg.fieldName}") AS ${agg.alias}`);
    }
  });

  const groupByClause = `GROUP BY ${groupByFields.map((field) => `${tableAlias}."${field}"`).join(", ")}`;

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
  field: SelectionAnalysis,
  groupByInfo: GroupByInfo,
  dottedQuotedName: string,
  tableAlias: string,
  whereClause: string,
): string => {
  const { groupByFields, aggregations, hasItems, keyResolved, hasKey, keys, cteAlias } =
    groupByInfo;

  const selectClauses: string[] = [];

  if (hasKey) {
    // Add key object with group by fields
    const keyFields = keys
      .map((key) => `'${key.alias || key.name}', ${cteAlias}."${key.name}"`)
      .join(", ");

    selectClauses.push(`'${keyResolved}', json_build_object(${keyFields})`);
  }

  // Add aggregation results
  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`'${agg.nameResolved}', ${cteAlias}.${agg.alias}`);
    } else {
      selectClauses.push(
        `'${agg.nameResolved}', json_build_object('${agg.fieldAlias}', COALESCE(${cteAlias}.${agg.alias}, null))`,
      );
    }
  });

  // Add items if requested
  if (hasItems) {
    const itemsSelection = field.selections?.find((sel) => sel.name === "items");

    if (itemsSelection?.selections) {
      const itemFields = itemsSelection.selections
        .filter((sel) => !isAggregationField(sel.name) && sel.name !== "items")
        .map((sel) => `'${sel.alias || sel.name}', ${tableAlias}."${sel.name}"`)
        .join(", ");

      if (itemFields) {
        const joinConditions = groupByFields.map(
          (field) => `${tableAlias}."${field}" = ${cteAlias}."${field}"`,
        );

        const whereConditions = whereClause
          ? `${whereClause} AND ${joinConditions.join(" AND ")}`
          : `WHERE ${joinConditions.join(" AND ")}`;

        selectClauses.push(`'${itemsSelection.alias || itemsSelection.name}', COALESCE((
          SELECT json_agg(json_build_object(${itemFields}))
          FROM ${dottedQuotedName} ${tableAlias}
          ${whereConditions}
        ), '[]'::json)`);
      }
    }
  }

  const orderByClause = buildOrderByClausePG(entities, field, cteAlias);

  return `SELECT json_agg(json_build_object(${selectClauses.join(",\n    ")}) ${orderByClause})
    FROM ${cteAlias}`;
};

export const generateSQL = (
  entities: MergedEntities,
  operation: OperationAnalysis,
  variables: Record<string, unknown> = {},
  forHashMethod: boolean = false,
): string => {
  if (forHashMethod) {
    return `SELECT MD5((${buildSQLForField(entities, operation.variables ?? [], variables, operation.fields[0], null, null, 1, {})})::text) AS "ResultHash"`;
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

      const whereClause = buildWhereClausePG(
        entities,
        operation.variables ?? [],
        variablesWithDefault,
        field,
        tableAlias,
        null,
        null,
        index + 1,
        {},
        true,
      );

      const cte = buildAggregationCTE(groupByInfo, dottedQuotedName, tableAlias, whereClause);
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

    fieldQueries.push(`'${field.alias || field.name}', ${fieldSQL}`);
  });

  const cteClause = ctes.length > 0 ? `WITH\n${ctes.join(",\n")}\n` : "";

  return `
    ${cteClause}SELECT json_build_object(
      ${fieldQueries.join(",\n")}
    ) as json_result`;
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

  const whereClause = buildWhereClausePG(
    entities,
    variablesDefinition,
    variables,
    field,
    tableAlias,
    parentTableName,
    parentTableAlias,
    level,
    aliasMap,
    true,
  );

  // Check if this is a GROUP BY query
  const groupByInfo = extractAggregationInfo(field, tableAlias);

  if (groupByInfo) {
    // Handle GROUP BY aggregation query
    const mainQuery = buildGroupedQuery(
      entities,
      field,
      groupByInfo,
      dottedQuotedName,
      tableAlias,
      whereClause,
    );

    return `COALESCE((${mainQuery}), '[]'::json)`;
  }

  // Original logic for non-aggregation queries
  const selectList = processFieldSelectionsPG(
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
    ([name, selector]) => `'${name}', ${selector}`,
    true,
  );

  const fromClause = `FROM ${dottedQuotedName} ${tableAlias}`;

  const orderByClause = buildOrderByClausePG(entities, field, tableAlias);
  const paginationClause = buildPaginationClausePG(field, variablesDefinition);

  const isArraySelection = !!field.isArray && !withoutArrayWrapper;

  return `
    COALESCE((
      SELECT ${isArraySelection ? `json_agg(json_build_object(${selectList}) ${orderByClause})` : `json_build_object(${selectList})`} ${fromClause} ${whereClause} ${withoutArrayWrapper ? " LIMIT 1" : ""} ${paginationClause ? ` ${paginationClause}` : ""}
    ), '${isArraySelection ? "[]" : "null"}'::json)
  `;
};

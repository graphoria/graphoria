import type {
  OperationAnalysis,
  SelectionAnalysis,
  VariableDefinition,
} from "../../../../analyzeQuery/types";
import type { MergedEntities } from "../../../../configuration/getSchemas/mergeEntities";
import type { GroupByInfo, PageLimits } from "../../../common";

import {
  buildOrderByClauseMySQL,
  buildPaginationClauseMySQL,
  buildWhereClauseMySQL,
  extractAggregationInfo,
  filterBasedOnDirective,
  generateTableAlias,
  isAggregationField,
  isSingleQuery,
  processFieldSelectionsMySQL,
  sqlColumnName,
  wrapIdentifierMySQL,
} from "../../../common";

import { applyDirectives } from "../../../directives";

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
    selectClauses.push(`${tableAlias}.${wrapIdentifierMySQL(sqlName(field))}`);
  });

  // Add aggregations
  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`COUNT(*) AS ${agg.alias}`);
    } else {
      const func = agg.name.toUpperCase();
      selectClauses.push(
        `${func}(${tableAlias}.${wrapIdentifierMySQL(sqlName(agg.fieldName))}) AS ${agg.alias}`,
      );
    }
  });

  const groupByClause = `GROUP BY ${groupByFields.map((field) => `${tableAlias}.${wrapIdentifierMySQL(sqlName(field))}`).join(", ")}`;

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
          `${cteAlias}.${wrapIdentifierMySQL(sqlName(key.name))}`,
          key.directives,
          "mysql",
          variablesDefinition,
        );
        return `'${key.alias || key.name}', ${selector}`;
      })
      .join(", ");

    selectClauses.push(`'${keyResolved}', JSON_OBJECT(${keyFields})`);
  }

  // Add aggregation results
  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`'${agg.nameResolved}', ${cteAlias}.${agg.alias}`);
    } else {
      selectClauses.push(
        `'${agg.nameResolved}', JSON_OBJECT('${agg.fieldAlias}', COALESCE(${cteAlias}.${agg.alias}, NULL))`,
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
            `${tableAlias}.${wrapIdentifierMySQL(sqlName(sel.name))}`,
            sel.directives,
            "mysql",
            variablesDefinition,
          );
          return `'${sel.alias || sel.name}', ${selector}`;
        })
        .join(", ");

      if (itemFields) {
        const joinConditions = groupByFields.map(
          (groupByField) =>
            `${tableAlias}.${wrapIdentifierMySQL(sqlName(groupByField))} = ${cteAlias}.${wrapIdentifierMySQL(sqlName(groupByField))}`,
        );

        const whereConditions = whereClause
          ? `${whereClause} AND ${joinConditions.join(" AND ")}`
          : `WHERE ${joinConditions.join(" AND ")}`;

        selectClauses.push(`'${itemsSelection.alias || itemsSelection.name}', COALESCE((
          SELECT JSON_ARRAYAGG(JSON_OBJECT(${itemFields}))
          FROM ${dottedQuotedName} ${tableAlias}
          ${whereConditions}
        ), JSON_ARRAY())`);
      }
    }
  }

  const orderByClause = buildOrderByClauseMySQL(entities, field, cteAlias);

  return `SELECT JSON_ARRAYAGG(JSON_OBJECT(${selectClauses.join(",\n    ")}) ${orderByClause})
    FROM ${cteAlias}`;
};

export const generateSQL = (
  entities: MergedEntities,
  operation: OperationAnalysis,
  variables: Record<string, unknown> = {},
  forHashMethod: boolean = false,
  pageLimits: PageLimits | null = null,
): string => {
  if (forHashMethod) {
    return `SELECT MD5((${buildSQLForField(entities, operation.variables ?? [], variables, operation.fields[0], null, null, 1, {}, pageLimits)})) AS ResultHash`;
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

      const whereClause = buildWhereClauseMySQL(
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
      pageLimits,
    );

    fieldQueries.push(`'${field.alias || field.name}', ${fieldSQL}`);
  });

  const cteClause = ctes.length > 0 ? `WITH\n${ctes.join(",\n")}\n` : "";

  return `
    ${cteClause}SELECT JSON_OBJECT(
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
  pageLimits: PageLimits | null,
): string => {
  const tableAlias = generateTableAlias(level);

  const withoutArrayWrapper = isSingleQuery(field.name);

  const foundTable = entities.queriesMap[field.name];

  if (!foundTable) {
    throw new Error(`Table not found for field: ${field.name}`);
  }

  const { dottedQuotedName, resolverName } = foundTable;

  aliasMap[tableAlias] = resolverName;

  const whereClause = buildWhereClauseMySQL(
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

    return `COALESCE((${mainQuery}), JSON_ARRAY())`;
  }

  // Original logic for non-aggregation queries
  const selectList = processFieldSelectionsMySQL(
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
        pageLimits,
      ),
    ([name, selector]) => `'${name}', ${selector}`,
  );

  const fromClause = `FROM ${dottedQuotedName} ${tableAlias}`;

  const orderByClause = buildOrderByClauseMySQL(entities, field, tableAlias);
  const paginationClause = buildPaginationClauseMySQL(
    field,
    variablesDefinition,
    variables,
    pageLimits,
  );

  const isArraySelection = !!field.isArray && !withoutArrayWrapper;

  // JSON_ARRAYAGG accepts no ORDER BY of its own and collapses the rows before
  // LIMIT can trim them, so both ordering and pagination have to happen in a
  // derived table that the aggregate then reads.
  if (isArraySelection && (orderByClause || paginationClause)) {
    const pageAlias = `${tableAlias}_page`;
    // A nested selection is correlated to its parent through the where clause,
    // and a plain derived table may not carry an outer reference. LATERAL lifts
    // that restriction — MySQL 8.0.14 and newer. Unordered, unpaginated nested
    // selections never take this branch, so older servers keep working for them.
    const lateral = parentTableName ? "LATERAL " : "";

    // NO_MERGE is load-bearing, not a hint about performance: without it MySQL
    // merges the derived table into the outer query and discards its ORDER BY,
    // so the array comes back in storage order. A LIMIT blocks the merge on its
    // own, which is why only the unpaginated ordering was affected.
    return `
    COALESCE((
      SELECT /*+ NO_MERGE(${pageAlias}) */ JSON_ARRAYAGG(${pageAlias}.obj)
      FROM ${lateral}(
        SELECT JSON_OBJECT(${selectList}) AS obj ${fromClause} ${whereClause} ${orderByClause} ${paginationClause}
      ) ${pageAlias}
    ), JSON_ARRAY())
  `;
  }

  return `
    COALESCE((
      SELECT ${isArraySelection ? `JSON_ARRAYAGG(JSON_OBJECT(${selectList}))` : `JSON_OBJECT(${selectList})`} ${fromClause} ${whereClause} ${orderByClause}${withoutArrayWrapper ? " LIMIT 1" : ""}
    ), ${isArraySelection ? "JSON_ARRAY()" : "null"})
  `;
};

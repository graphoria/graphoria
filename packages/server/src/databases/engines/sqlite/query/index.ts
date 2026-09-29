import type {
  OperationAnalysis,
  SelectionAnalysis,
  VariableDefinition,
} from "../../../../analyzeQuery/types";
import type { MergedEntities } from "../../../../configuration/getSchemas/mergeEntities";
import type { GroupByInfo, PageLimits, QueryPathFrame } from "../../../common";

import {
  buildOrderByClauseSQLite,
  buildPaginationClauseSQLite,
  buildWhereClauseSQLite,
  extractAggregationInfo,
  filterBasedOnDirective,
  generateTableAlias,
  isAggregationField,
  isSingleQuery,
  processFieldSelectionsSQLite,
  sqlColumnName,
  sqliteJsonValue,
  wrapIdentifierSQLite,
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
  const column = (fieldName: string) =>
    `${tableAlias}.${wrapIdentifierSQLite(sqlColumnName(entities, tableName, fieldName))}`;

  const selectClauses: string[] = [];

  groupByFields.forEach((field) => {
    selectClauses.push(column(field));
  });

  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`COUNT(*) AS ${agg.alias}`);
    } else {
      selectClauses.push(`${agg.name.toUpperCase()}(${column(agg.fieldName)}) AS ${agg.alias}`);
    }
  });

  return `${cteAlias} AS (
    SELECT
      ${selectClauses.join(",\n      ")}
    FROM ${dottedQuotedName} ${tableAlias}
    ${whereClause}
    GROUP BY ${groupByFields.map(column).join(", ")}
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
  const column = (alias: string, fieldName: string) =>
    `${alias}.${wrapIdentifierSQLite(sqlName(fieldName))}`;
  const value = (alias: string, selection: SelectionAnalysis) =>
    applyDirectives(
      sqliteJsonValue(entities, field.name, sqlName(selection.name), column(alias, selection.name)),
      selection.directives,
      "sqlite",
      variablesDefinition,
    );

  const selectClauses: string[] = [];

  if (hasKey) {
    const keyFields = keys
      .map((key) => `'${key.alias || key.name}', ${value(cteAlias, key)}`)
      .join(", ");

    selectClauses.push(`'${keyResolved}', json_object(${keyFields})`);
  }

  aggregations.forEach((agg) => {
    if (agg.name === "count") {
      selectClauses.push(`'${agg.nameResolved}', ${cteAlias}.${agg.alias}`);
    } else {
      selectClauses.push(
        `'${agg.nameResolved}', json_object('${agg.fieldAlias}', ${cteAlias}.${agg.alias})`,
      );
    }
  });

  if (hasItems) {
    const itemsSelection = field.selections?.find((sel) => sel.name === "items");

    if (itemsSelection?.selections) {
      const itemFields = itemsSelection.selections
        .filter((sel) => !isAggregationField(sel.name) && sel.name !== "items")
        .map((sel) => `'${sel.alias || sel.name}', ${value(tableAlias, sel)}`)
        .join(", ");

      if (itemFields) {
        const joinConditions = groupByFields.map(
          (groupByField) =>
            `${column(tableAlias, groupByField)} = ${column(cteAlias, groupByField)}`,
        );

        const whereConditions = whereClause
          ? `${whereClause} AND ${joinConditions.join(" AND ")}`
          : `WHERE ${joinConditions.join(" AND ")}`;

        selectClauses.push(`'${itemsSelection.alias || itemsSelection.name}', COALESCE((
          SELECT json_group_array(json_object(${itemFields}))
          FROM ${dottedQuotedName} ${tableAlias}
          ${whereConditions}
        ), json('[]'))`);
      }
    }
  }

  const orderByClause = buildOrderByClauseSQLite(entities, field, cteAlias);

  return `SELECT json_group_array(json_object(${selectClauses.join(",\n    ")}) ${orderByClause})
    FROM ${cteAlias}`;
};

export const generateSQL = (
  entities: MergedEntities,
  operation: OperationAnalysis,
  variables: Record<string, unknown> = {},
  forHashMethod: boolean = false,
  pageLimits: PageLimits | null = null,
): string => {
  // SQLite has no md5(). The poller only compares hashes, so the result text
  // itself serves: it changes exactly when a hash of it would.
  if (forHashMethod) {
    return `SELECT (${buildSQLForField(entities, operation.variables ?? [], variables, operation.fields[0], null, null, 1, {}, pageLimits)}) AS "ResultHash"`;
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

  const filteredFields = operation.fields?.filter((f) =>
    filterBasedOnDirective(f, operation.variables ?? [], variablesWithDefault),
  );

  const ctes: string[] = [];
  const fieldQueries: string[] = [];

  filteredFields?.forEach((field, index) => {
    const tableAlias = generateTableAlias(index + 1);
    const groupByInfo = extractAggregationInfo(field, tableAlias);

    if (groupByInfo) {
      const { dottedQuotedName } = entities.queriesMap[field.name]!;

      const whereClause = buildWhereClauseSQLite(
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

      ctes.push(
        buildAggregationCTE(
          entities,
          field.name,
          groupByInfo,
          dottedQuotedName,
          tableAlias,
          whereClause,
        ),
      );
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
    ${cteClause}SELECT json_object(
      ${fieldQueries.join(",\n")}
    ) AS json_result`;
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
  ancestors: readonly QueryPathFrame[] = [],
): string => {
  const tableAlias = generateTableAlias(level);

  const withoutArrayWrapper = isSingleQuery(field.name);

  const foundTable = entities.queriesMap[field.name];

  if (!foundTable) {
    throw new Error(`Table not found for field: ${field.name}`);
  }

  const { dottedQuotedName, resolverName } = foundTable;

  aliasMap[tableAlias] = resolverName;

  const whereClause = buildWhereClauseSQLite(
    entities,
    variablesDefinition,
    variables,
    field,
    tableAlias,
    parentTableName,
    parentTableAlias,
    level,
    aliasMap,
    ancestors,
  );

  const groupByInfo = extractAggregationInfo(field, tableAlias);

  if (groupByInfo) {
    const mainQuery = buildGroupedQuery(
      entities,
      variablesDefinition,
      field,
      groupByInfo,
      dottedQuotedName,
      tableAlias,
      whereClause,
    );

    return `COALESCE((${mainQuery}), json('[]'))`;
  }

  const selectList = processFieldSelectionsSQLite(
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
        [...ancestors, { table: resolverName, alias: tableAlias }],
      ),
    ([name, selector]) => `'${name}', ${selector}`,
  );

  const fromClause = `FROM ${dottedQuotedName} ${tableAlias}`;

  const orderByClause = buildOrderByClauseSQLite(entities, field, tableAlias);
  const paginationClause = buildPaginationClauseSQLite(
    field,
    variablesDefinition,
    variables,
    pageLimits,
  );

  const isArraySelection = !!field.isArray && !withoutArrayWrapper;

  // json_group_array collapses the rows into one, so a LIMIT beside it trims
  // aggregate rows, not table rows. Paginate in a derived table and aggregate
  // that, carrying the order out through ROW_NUMBER. A derived-table column loses
  // the JSON subtype json_object() gave it, and json() restores it: without it
  // every element arrives as a string.
  if (isArraySelection && paginationClause) {
    const pageAlias = `${tableAlias}_page`;

    return `
    COALESCE((
      SELECT json_group_array(json(${pageAlias}.obj) ORDER BY ${pageAlias}.__ord)
      FROM (
        SELECT json_object(${selectList}) AS obj, ROW_NUMBER() OVER (${orderByClause}) AS __ord ${fromClause} ${whereClause} ${orderByClause} ${paginationClause}
      ) ${pageAlias}
    ), json('[]'))
  `;
  }

  // A fallback must be a JSON value: the text 'null' or '[]' would be embedded
  // as a string.
  return `
    COALESCE((
      SELECT ${isArraySelection ? `json_group_array(json_object(${selectList}) ${orderByClause})` : `json_object(${selectList})`} ${fromClause} ${whereClause} ${withoutArrayWrapper ? " LIMIT 1" : ""} ${paginationClause ? ` ${paginationClause}` : ""}
    ), json('${isArraySelection ? "[]" : "null"}'))
  `;
};

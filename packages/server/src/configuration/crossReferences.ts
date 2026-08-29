import { isString } from "es-toolkit/compat";

import type { Configuration } from "../types/configuration";
import type { ProcedureResolver, TableResolver } from "../types/db";

import { FILTER_OPERATORS } from "../config/types/auth";
import { columnFieldName } from "../databases/transformers/graphqlName";

/**
 * Everything the configuration is allowed to point at that only exists once the
 * databases have been introspected.
 */
export type KnownEntities = {
  tables: TableResolver[];
  storedProcedures: ProcedureResolver[];
  /**
   * Every table name a database reported, keyed by database name and recorded
   * *before* exclusions are applied. `excludedTables` names are absent from
   * `tables` by construction, so they cannot be resolved against it.
   */
  tableNamesByDatabase: Record<string, string[]>;
};

const OPERATORS = new Set<string>(FILTER_OPERATORS);

const isOperatorObject = (value: object): boolean =>
  Object.keys(value).some((key) => OPERATORS.has(key));

const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];

    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }

    previous = current;
  }

  return previous[b.length]!;
};

/**
 * Closest candidate, or nothing when none is close enough. The budget — half the
 * misspelling's length, never more than three edits — is what keeps the hint
 * honest: without it every unresolved name draws a confident suggestion picked
 * from whatever happened to be shortest.
 */
const nearest = (value: string, candidates: readonly string[]): string | undefined => {
  const needle = value.toLowerCase();

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());

    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const budget = Math.min(3, Math.max(1, Math.floor(needle.length / 2)));

  return best !== undefined && bestDistance <= budget ? best : undefined;
};

const segment = (key: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

const unresolved = (
  path: string,
  kind: string,
  value: string,
  candidates: readonly string[],
): string => {
  const suggestion = nearest(value, candidates);

  return `${path} — no ${kind} named ${JSON.stringify(value)}${
    suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : ""
  }`;
};

/**
 * Column references are matched case-insensitively against both the GraphQL
 * field name and the raw SQL name. That is looser than the query builder, which
 * compares field names exactly — deliberately so. A boot-blocking check that is
 * stricter than the runtime would refuse configurations that work today; one
 * that is slightly looser still catches every genuine typo.
 */
const columnNames = (table: TableResolver): string[] =>
  table.columns.flatMap((column) => {
    const field = columnFieldName(column);

    return field === column.name ? [field] : [field, column.name];
  });

const hasColumn = (table: TableResolver, name: string): boolean =>
  columnNames(table).some((candidate) => candidate.toLowerCase() === name.toLowerCase());

/** Table names reachable from `table` through a relation, in either direction. */
const relatedTableNames = (table: TableResolver): string[] => [
  ...table.relationships.map((fk) => fk.toResolverName),
  ...table.relationshipsReversed.map((fk) => fk.fromResolverName),
];

const collectListErrors = (
  path: string,
  kind: string,
  permission: "ALL" | string[] | undefined,
  candidates: readonly string[],
): string[] => {
  if (!Array.isArray(permission)) return [];

  const known = new Set(candidates.map((name) => name.toLowerCase()));

  return permission
    .filter((name) => !known.has(name.toLowerCase()))
    .map((name) => unresolved(`${path}[${JSON.stringify(name)}]`, kind, name, candidates));
};

/**
 * Every name a configuration points at that resolves to nothing, with the config
 * path that carries it. Returns them all rather than throwing on the first, so a
 * misconfigured deployment is fixed in one pass.
 *
 * A permission naming something that does not exist fails closed — the role
 * simply loses the entity — which is why these never surfaced on their own: the
 * rule the operator wrote silently does not apply.
 */
export const collectCrossReferenceErrors = (
  configuration: Configuration,
  known: KnownEntities,
): string[] => {
  const errors: string[] = [];

  const tableNames = known.tables.map((table) => table.resolverName);
  const tablesByName = new Map(
    known.tables.map((table) => [table.resolverName.toLowerCase(), table]),
  );
  const procedureNames = known.storedProcedures.map((procedure) => procedure.name);
  const queueNames = configuration.queues.map((queue) => queue.name);
  const operationNames = Object.keys(configuration.operations);
  const remoteSchemaNames = (configuration.remoteSchemas ?? []).map((remote) => remote.name);
  const remoteRESTNames = (configuration.remoteREST ?? []).map((remote) => remote.name);

  const collectFilterErrors = (
    filter: object,
    table: TableResolver,
    path: string,
    visited: ReadonlySet<string>,
  ): void => {
    for (const [key, value] of Object.entries(filter) as [string, unknown][]) {
      const keyPath = `${path}${segment(key)}`;

      // Mirrors buildConditions: an object carrying a known operator is a column
      // filter, anything else is a nested relation.
      if (typeof value !== "object" || value === null || isOperatorObject(value)) {
        if (!hasColumn(table, key)) {
          errors.push(
            unresolved(keyPath, `column on table ${JSON.stringify(table.resolverName)}`, key, [
              ...columnNames(table),
              ...relatedTableNames(table),
            ]),
          );
        }

        continue;
      }

      const related = relatedTableNames(table);
      const nested = related.includes(key) ? tablesByName.get(key.toLowerCase()) : undefined;

      if (!nested) {
        errors.push(
          unresolved(
            keyPath,
            `column or relation on table ${JSON.stringify(table.resolverName)}`,
            key,
            [...columnNames(table), ...related],
          ),
        );

        continue;
      }

      // A filter that walks back into a table already on the path would recurse
      // forever; the runtime would too, so stop rather than report it here.
      if (visited.has(nested.resolverName)) continue;

      collectFilterErrors(value, nested, keyPath, new Set([...visited, nested.resolverName]));
    }
  };

  for (const [role, permissions] of Object.entries(configuration.auth.permissions ?? {})) {
    const base = `auth.permissions${segment(role)}`;

    errors.push(
      ...collectListErrors(
        `${base}.storedProcedures`,
        "stored procedure",
        permissions.storedProcedures,
        procedureNames,
      ),
      ...collectListErrors(`${base}.queues`, "queue", permissions.queues, queueNames),
      ...collectListErrors(
        `${base}.operations`,
        "operation",
        permissions.operations,
        operationNames,
      ),
      ...collectListErrors(
        `${base}.remoteSchemas`,
        "remote schema",
        permissions.remoteSchemas,
        remoteSchemaNames,
      ),
      ...collectListErrors(
        `${base}.remoteREST`,
        "remote REST API",
        permissions.remoteREST,
        remoteRESTNames,
      ),
    );

    if (isString(permissions.tables)) continue;

    for (const [tableKey, tablePermission] of Object.entries(permissions.tables)) {
      const tablePath = `${base}.tables${segment(tableKey)}`;
      const table = tablesByName.get(tableKey.toLowerCase());

      if (!table) {
        errors.push(unresolved(tablePath, "table or view", tableKey, tableNames));

        continue;
      }

      if (!isString(tablePermission.columns)) {
        for (const column of tablePermission.columns) {
          if (!hasColumn(table, column)) {
            errors.push(
              unresolved(
                `${tablePath}.columns[${JSON.stringify(column)}]`,
                "column",
                column,
                columnNames(table),
              ),
            );
          }
        }
      }

      for (const [index, orderBy] of (tablePermission.orderBy ?? []).entries()) {
        if (!hasColumn(table, orderBy.column)) {
          errors.push(
            unresolved(
              `${tablePath}.orderBy[${index}].column`,
              "column",
              orderBy.column,
              columnNames(table),
            ),
          );
        }
      }

      if (tablePermission.filter) {
        collectFilterErrors(
          tablePermission.filter,
          table,
          `${tablePath}.filter`,
          new Set([table.resolverName]),
        );
      }
    }
  }

  for (const [index, queue] of configuration.queues.entries()) {
    const topicNames = Object.keys(queue.topics);
    const base = `queues[${index}]`;

    for (const [group, entries] of [
      ["publishers", queue.publishers],
      ["subscribers", queue.subscribers],
    ] as const) {
      for (const [key, entry] of Object.entries(entries)) {
        if (!topicNames.includes(entry.topic)) {
          errors.push(
            unresolved(`${base}.${group}${segment(key)}.topic`, "topic", entry.topic, topicNames),
          );
        }
      }
    }
  }

  for (const [index, database] of configuration.enabledDatabases.entries()) {
    if (!database.schema) continue;

    const introspected = known.tableNamesByDatabase[database.name] ?? [];
    const base = `databases[${index}].schema`;

    errors.push(
      ...collectListErrors(
        `${base}.excludedTables`,
        "table or view",
        database.schema.excludedTables,
        introspected,
      ),
    );

    // Exact, unlike every other name here, because the override lookup itself is
    // exact — two tables can differ only in case, and picking one of them for a
    // key that matches both would be a guess. A mis-cased key is reported rather
    // than quietly resolved.
    for (const tableKey of Object.keys(database.schema.database)) {
      if (!introspected.includes(tableKey)) {
        errors.push(
          unresolved(
            `${base}.database${segment(tableKey)}`,
            "table or view",
            tableKey,
            introspected,
          ),
        );
      }
    }
  }

  return errors;
};

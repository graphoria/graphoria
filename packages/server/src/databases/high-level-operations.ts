import { isString } from "es-toolkit";

import type { RemoteRESTResolved } from "../remoteREST/types";
import type { RemoteSchemaResolved } from "../remoteSchemas/types";
import type {
  Auth,
  Database,
  MessageQueue,
  Operations,
  Permissions,
  TableFilter,
  VirtualColumns,
} from "../types/configuration";
import type { Column, ProcedureResolver, TableResolver, Tables } from "../types/db";

import { getDatabaseStructure } from "./metadata/structure";
import { buildProcedureResolver, buildTableResolver } from "./transformers/data-transformers";
import { genResolverName } from "./transformers/genResolverName";

/**
 * High-level database operations that combine multiple lower-level operations
 */

export const getDatabasesStructure = async (
  databases: Database[],
  auth?: Auth,
  fetchStructure = getDatabaseStructure,
) => {
  const entities: TableResolver[] = [];
  const enhancedStoredProcedures: ProcedureResolver[] = [];

  // The auth user table holds the password hash and must never be served via
  // the generated API. Its resolver key matches t.schemaName, which is always
  // computed with the default `{schema}_{name}` naming (see enrichTable).
  const authUserKey = auth?.enabled
    ? genResolverName(auth.schema ?? "auth", "user", "table")
    : undefined;

  for (const db of databases) {
    const { tables, storedProcedures } = await fetchStructure(db);

    const tablesToAdd = tables
      .reduce<Tables>((acc, t) => {
        if (authUserKey && t.schemaName === authUserKey) return acc;
        if (db.schema?.excludedTables.includes(t.schemaName)) return acc;

        const tableOverride = db.schema?.database[t.schemaName];

        if (!tableOverride) {
          acc.push(t);

          return acc;
        }

        if (tableOverride.description !== undefined) {
          t.tableDescription = tableOverride.description;
        }

        for (const [colName, desc] of Object.entries(tableOverride.columnDescriptions)) {
          const column = t.columns.find((col) => col.name.toLowerCase() === colName.toLowerCase());
          if (column) column.description = desc;
        }

        if (tableOverride.columns.length) {
          // Mix database columns with virtual columns from configuration
          t.columns = [...t.columns, ...tableOverride.columns] as Column[];
        }

        if (tableOverride.relationships.length) {
          const additionalForeignKeys = tableOverride.relationships.map((fk) => {
            const toTable = tables.find(
              (t) =>
                `${fk.schema}_${fk.name}`.toLowerCase() === `${t.schema}_${t.name}`.toLowerCase(),
            );

            if (!toTable) {
              throw new Error(`Referenced table ${fk.schema}_${fk.name} not found`);
            }

            return {
              dashedName: `${fk.schema}_${fk.name}`,
              schema: toTable.schema,
              name: toTable.name,
              columns: fk.columns.map((c) => {
                const target = toTable.columns.find(
                  (col) => col.name.toLowerCase() === c.target.toLowerCase(),
                );

                if (!target) {
                  throw new Error(
                    `Referenced column ${c.target} not found in table ${toTable.name}`,
                  );
                }

                const tableColumn = t.columns.find(
                  (col) => col.name.toLowerCase() === c.source.toLowerCase(),
                );

                if (!tableColumn) {
                  throw new Error(`Column ${c.source} not found in table ${t.name}`);
                }

                return {
                  source: tableColumn.name,
                  target: target.name,
                };
              }),
            };
          });

          if (additionalForeignKeys.length) {
            t.foreignKeys = [...t.foreignKeys, ...additionalForeignKeys];
          }
        }

        acc.push(t);

        return acc;
      }, [])
      .map((t) => buildTableResolver(tables, t, db));

    const storedProceduresToAdd = storedProcedures.map((sp) => buildProcedureResolver(sp, db));

    entities.push(...tablesToAdd);
    enhancedStoredProcedures.push(...storedProceduresToAdd);
  }

  return { tables: entities, storedProcedures: enhancedStoredProcedures };
};

export type EntitiesOfRole = {
  tables: TableResolver[];
  storedProcedures: ProcedureResolver[];
  queues: MessageQueue[];
  operations: Operations;
  remoteSchemas: RemoteSchemaResolved[];
  remoteREST: RemoteRESTResolved[];
};

/**
 * Filters an array-shaped collection by a role's permission entry: `"ALL"`
 * keeps everything, a `string[]` keeps items whose name (case-insensitive) is
 * listed, anything else (undefined / malformed) keeps nothing. RBAC fails
 * closed — an unrecognized permission shape grants no access.
 */
const filterByPermission = <T>(
  items: T[],
  permission: "ALL" | string[] | undefined,
  getName: (item: T) => string,
): T[] => {
  if (permission === "ALL") return items;
  if (!Array.isArray(permission)) return [];
  const allowed = permission.map((name) => name.toLowerCase());
  return items.filter((item) => allowed.includes(getName(item).toLowerCase()));
};

/**
 * Record-keyed counterpart of {@link filterByPermission} for name-keyed
 * collections (operations). Same `"ALL"` / allowlist / fail-closed rule.
 */
const filterRecordByPermission = <T>(
  items: Record<string, T>,
  permission: "ALL" | string[] | undefined,
): Record<string, T> => {
  if (permission === "ALL") return items;
  if (!Array.isArray(permission)) return {};
  const allowed = permission.map((name) => name.toLowerCase());
  return Object.fromEntries(
    Object.entries(items).filter(([name]) => allowed.includes(name.toLowerCase())),
  );
};

export const sourcesForEachRole = (
  tables: TableResolver[],
  storedProcedures: ProcedureResolver[],
  queues: MessageQueue[],
  operations: Operations,
  permissionsMapping: Permissions = {},
  remoteSchemas: RemoteSchemaResolved[] = [],
  remoteREST: RemoteRESTResolved[] = [],
) =>
  Object.entries(permissionsMapping).reduce<Record<string, EntitiesOfRole>>(
    (acc, [role, permissions]) => {
      // Lowercase-keyed view of permissions.tables so filter and column lookup
      // see the same normalized shape. Without this, an uppercase permission
      // key would pass the filter step but crash the column-allowlist lookup.
      const permissionsTablesByLowerKey = !isString(permissions.tables)
        ? Object.fromEntries(
            Object.entries(permissions.tables).map(([k, v]) => [k.toLowerCase(), v]),
          )
        : null;

      // Object-form permissions list the allowed tables as keys; "ALL" (the only
      // string form left after zod normalization) keeps every table.
      const allowedTables = filterByPermission(
        tables,
        permissionsTablesByLowerKey ? Object.keys(permissionsTablesByLowerKey) : "ALL",
        (t) => t.resolverName,
      );

      const filteredTables: TableResolver[] = allowedTables.map((t) => {
        let allowedColumns: VirtualColumns = t.columns as VirtualColumns;
        let rolePermission: TableFilter | undefined;

        if (permissionsTablesByLowerKey) {
          const tablePerm = permissionsTablesByLowerKey[t.resolverName.toLowerCase()]!;

          if (isString(tablePerm.columns) && tablePerm.columns === "ALL") {
            allowedColumns = t.columns as VirtualColumns;
          } else {
            const columnsList = tablePerm.columns.map((col: string) => col.toLowerCase());

            allowedColumns = t.columns.filter((c) =>
              columnsList.includes(c.name.toLowerCase()),
            ) as VirtualColumns;
          }

          rolePermission = { filter: tablePerm.filter, orderBy: tablePerm.orderBy };
        }

        return {
          ...t,
          columns: allowedColumns,
          rolePermission,
          relationships: t.relationships.filter(
            (fk) =>
              allowedTables.find((t) => t.resolverName === fk.fromInternalName) &&
              allowedTables.find((t) => t.resolverName === fk.toInternalName),
          ),
          relationshipsReversed: t.relationshipsReversed.filter(
            (fk) =>
              allowedTables.find((t) => t.resolverName === fk.fromInternalName) &&
              allowedTables.find((t) => t.resolverName === fk.toInternalName),
          ),
        };
      });

      const filteredStoredProcedures = filterByPermission(
        storedProcedures,
        permissions.storedProcedures,
        (sp) => sp.name,
      );

      const filteredQueues = filterByPermission(queues, permissions.queues, (q) => q.name);

      const filteredOperations = filterRecordByPermission(operations, permissions.operations);

      const filteredRemoteSchemas = filterByPermission(
        remoteSchemas,
        permissions.remoteSchemas,
        (rs) => rs.config.name,
      );

      const filteredRemoteREST = filterByPermission(
        remoteREST,
        permissions.remoteREST,
        (rr) => rr.config.name,
      );

      acc[role] = {
        tables: filteredTables,
        storedProcedures: filteredStoredProcedures,
        queues: filteredQueues,
        operations: filteredOperations,
        remoteSchemas: filteredRemoteSchemas,
        remoteREST: filteredRemoteREST,
      };

      return acc;
    },
    {},
  );

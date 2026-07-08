import { isString } from "es-toolkit";

import { AuthConfigZod } from "../../config";
import type { TableFilter } from "../configuration";

// Re-export base types and schemas from the config module
export type {
  DirectionUnion,
  OrderByClause,
  FilterCondition,
  TablePermission,
  RolePermission,
  AuthConfig,
} from "../../config";

export {
  DirectionUnionZod,
  OrderByClauseZod,
  FilterConditionZod,
  TablePermissionZod,
  RolePermissionZod,
  AuthConfigZod,
} from "../../config";

// ============================================================================
// Permissions Normalization Transform
// ============================================================================

type TablePermissionsDictionary = Record<
  string,
  {
    columns: "ALL" | string[];
  } & TableFilter
>;

/**
 * Auth schema with permissions-dictionary normalization.
 * The transform normalizes tables from the three accepted input forms
 * (string[], "ALL", Record<string, "ALL" | TablePermission>) into a single
 * consistent runtime shape: either "ALL" or Record<string, { columns, ... }>.
 */
export const AuthZod = AuthConfigZod.transform((val) => {
  if (!val) return undefined;

  return {
    ...val,
    permissions: Object.fromEntries(
      Object.entries(val.permissions).map(([role, perms]) => {
        let tablesComputed: "ALL" | TablePermissionsDictionary = {};

        if (isString(perms.tables) && perms.tables === "ALL") {
          tablesComputed = "ALL";
        } else if (Array.isArray(perms.tables)) {
          tablesComputed = perms.tables.reduce<TablePermissionsDictionary>(
            (acc, table) => ({
              ...acc,
              [table.toLowerCase()]: { columns: "ALL" },
            }),
            {},
          );
        } else if (typeof perms.tables === "object" && perms.tables !== null) {
          tablesComputed = Object.fromEntries(
            Object.entries(perms.tables).map(([table, tablePerms]) => {
              if (isString(tablePerms) && tablePerms === "ALL") {
                return [table.toLowerCase(), { columns: "ALL" }];
              } else if (
                typeof tablePerms === "object" &&
                tablePerms !== null &&
                "columns" in tablePerms
              ) {
                return [
                  table.toLowerCase(),
                  {
                    columns: tablePerms.columns,
                    filter: tablePerms.filter,
                    orderBy: tablePerms.orderBy,
                  },
                ];
              } else {
                return [table.toLowerCase(), { columns: "ALL" }];
              }
            }),
          );
        }

        return [
          role,
          {
            ...perms,
            tables: tablesComputed,
          },
        ];
      }),
    ),
  };
});

import type { DatabaseType } from "../../../types/configuration";
import type { TableResolver } from "../../../types/db";

import { qualifiedNameFp, wrapIdentifierFp } from "../../common";

export const generateInsertSQL =
  (toDb: DatabaseType) =>
  // oxlint-disable-next-line typescript/no-explicit-any
  (table: TableResolver, data: Record<string, any>[]) => {
    const columnNames = table.columns.map((column) => wrapIdentifierFp(toDb)(column.name));

    const valueRows = data.map((row) => {
      const values = table.columns.map((column) => {
        const value = row[column.name];
        if (typeof value === "string") {
          return toDb === "mssql" ? `N'${value}'` : `'${value}'`;
        }
        return value;
      });
      return `(${values.join(",")})`;
    });

    // Quoted for the target engine, not the source: table.dottedQuotedName
    // carries the source dialect's delimiters and the two differ when converting.
    return `INSERT INTO ${qualifiedNameFp(toDb)(table)} (${columnNames.join(",")}) VALUES\n${valueRows.join(",\n")}`;
  };

export type GenerateInsertSQL = ReturnType<typeof generateInsertSQL>;

export const generateInsertSQLMSSQL = generateInsertSQL("mssql");
export const generateInsertSQLPostgreSQL = generateInsertSQL("pg");
export const generateInsertSQLMySQL = generateInsertSQL("mysql");

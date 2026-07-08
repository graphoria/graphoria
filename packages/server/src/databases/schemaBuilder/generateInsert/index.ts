import type { DatabaseType } from "../../../types/configuration";
import type { TableResolver } from "../../../types/db";

export const generateInsertSQL =
  (toDb: DatabaseType) =>
  // oxlint-disable-next-line typescript/no-explicit-any
  (table: TableResolver, data: Record<string, any>[]) => {
    const columnNames = table.columns.map((column) => {
      if (toDb === "mssql") {
        return column.name;
      } else if (toDb === "mysql") {
        return `\`${column.name}\``;
      } else {
        return `"${column.name}"`;
      }
    });

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

    if (toDb === "pg") {
      return `INSERT INTO ${table?.dottedQuotedName} (${columnNames.join(",")}) VALUES\n${valueRows.join(",\n")}`;
    } else if (toDb === "mssql") {
      return `INSERT INTO ${table?.dottedName} (${columnNames.join(",")}) VALUES\n${valueRows.join(",\n")}`;
    } else if (toDb === "mysql") {
      // Generate backtick version of dotted name
      const parts = table.dottedName.split(".");
      const dottedBacktickName = parts.map((p) => `\`${p}\``).join(".");
      return `INSERT INTO ${dottedBacktickName} (${columnNames.join(",")}) VALUES\n${valueRows.join(",\n")}`;
    }

    return "";
  };

export type GenerateInsertSQL = ReturnType<typeof generateInsertSQL>;

export const generateInsertSQLMSSQL = generateInsertSQL("mssql");
export const generateInsertSQLPostgreSQL = generateInsertSQL("pg");
export const generateInsertSQLMySQL = generateInsertSQL("mysql");

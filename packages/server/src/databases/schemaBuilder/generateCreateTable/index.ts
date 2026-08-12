import { uniq } from "es-toolkit";

import type { Database, DatabaseType } from "../../../types/configuration";
import type { TableResolver, Tables } from "../../../types/db";

import { buildTableResolver } from "../../transformers/data-transformers";
import { generateSchemaCreationSQL } from "../generateSchemaCreation";
import { splitInternalName } from "../utils";

const typeMapping: Record<DatabaseType, Record<string, string>> = {
  mssql: {
    varchar: "VARCHAR(MAX)",
    int: "INT",
    smallint: "SMALLINT",
    nvarchar: "NVARCHAR(MAX)",
    datetime: "DATETIME",
    smalldatetime: "DATETIME",
    image: "IMAGE",
    uniqueidentifier: "UNIQUEIDENTIFIER",
    tinyint: "TINYINT",
  },
  pg: {
    varchar: "VARCHAR",
    int: "INTEGER",
    smallint: "SMALLINT",
    nvarchar: "VARCHAR",
    datetime: "TIMESTAMP",
    smalldatetime: "TIMESTAMP",
    image: "BYTEA",
    uniqueidentifier: "UUID",
    tinyint: "SMALLINT",
  },
  mysql: {
    varchar: "VARCHAR(255)",
    int: "INT",
    smallint: "SMALLINT",
    nvarchar: "VARCHAR(255)",
    datetime: "DATETIME",
    smalldatetime: "DATETIME",
    image: "BLOB",
    uniqueidentifier: "CHAR(36)",
    tinyint: "TINYINT",
  },
};

export type GenerateCreateTableSQLParameters = {
  schemaCreation?: boolean;
  schemaCreationIfExists?: boolean;
  tableCreationIfExists?: boolean;
};

export const generateCreateTableSQL =
  (toDb: DatabaseType) =>
  (
    table: TableResolver,
    {
      schemaCreation = true,
      schemaCreationIfExists = true,
      tableCreationIfExists = true,
    }: GenerateCreateTableSQLParameters = {},
  ) => {
    const columnsSQL = table.columns
      .map((column) => {
        const targetType = typeMapping[toDb][column.dataType] || column.dataType.toUpperCase();
        if (toDb === "mssql") {
          return `  ${column.name} ${targetType}`;
        } else if (toDb === "mysql") {
          return `  \`${column.name}\` ${targetType}${column.isNullable ? " NULL" : " NOT NULL"}`;
        } else {
          return `  "${column.name}" ${targetType}${column.isNullable ? " NULL" : " NOT NULL"}`;
        }
      })
      .join(",\n");

    let sql = "";

    const parsed = splitInternalName(`${table.schema}_${table.name}`, true);

    // Schema creation
    if (schemaCreation) {
      sql += generateSchemaCreationSQL(toDb)(table.schema, schemaCreationIfExists);
    }

    // Table creation
    if (toDb === "pg") {
      sql += `CREATE TABLE ${tableCreationIfExists ? "IF NOT EXISTS " : ""}${parsed?.nameDottedQuoted} (\n${columnsSQL}\n);`;
    } else if (toDb === "mssql") {
      if (tableCreationIfExists) {
        sql += `IF NOT EXISTS (SELECT * FROM sys.tables WHERE object_id = OBJECT_ID('${parsed?.nameDotted}'))\n`;
      }
      sql += `CREATE TABLE ${parsed?.nameDotted} (\n${columnsSQL}\n);`;
    } else if (toDb === "mysql") {
      // Generate backtick version of dotted name
      if (parsed?.nameDotted) {
        const parts = parsed.nameDotted.split(".");
        const dottedBacktickName = parts.map((p) => `\`${p}\``).join(".");
        sql += `CREATE TABLE ${tableCreationIfExists ? "IF NOT EXISTS " : ""}${dottedBacktickName} (\n${columnsSQL}\n);`;
      }
    }

    return sql;
  };

export type GenerateCreateTableSQL = ReturnType<typeof generateCreateTableSQL>;

export const generateCreateTableMSSQL = generateCreateTableSQL("mssql");
export const generateCreateTablePostgreSQL = generateCreateTableSQL("pg");
export const generateCreateTableMySQL = generateCreateTableSQL("mysql");

export const generateCreateTablesSQL = (
  db: Database,
  tables: Tables,
  options?: GenerateCreateTableSQLParameters,
) => {
  const schemas = uniq(tables.map((table) => table.schema)).filter(
    (schema) => !!schema,
  ) as string[];

  return [
    ...schemas.map((schema) => generateSchemaCreationSQL(db.type)(schema, true)),
    tables
      .filter((table) => table.entityType === "table")
      .map((table) =>
        generateCreateTableSQL(db.type)(buildTableResolver([table], table, db), {
          ...options,
          schemaCreation: false,
        }),
      )
      .join("\n\n"),
  ].join("\n\n");
};

export type GenerateCreateTablesSQL = typeof generateCreateTablesSQL;

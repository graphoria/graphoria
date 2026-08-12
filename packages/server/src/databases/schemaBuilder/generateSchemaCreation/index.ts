import type { DatabaseType } from "../../../types/configuration";

export const generateSchemaCreationSQL =
  (toDb: DatabaseType) =>
  (schema: string, schemaCreationIfExists = true) => {
    let sql = "";

    if (toDb === "pg") {
      sql += `CREATE SCHEMA ${schemaCreationIfExists ? "IF NOT EXISTS " : ""}"${schema}";`;
    } else if (toDb === "mssql") {
      if (schemaCreationIfExists) {
        sql += `IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = '${schema}')\n`;
        sql += `  EXEC('CREATE SCHEMA [${schema}]');`;
      } else {
        sql += `CREATE SCHEMA ${schema};`;
      }
    } else if (toDb === "mysql") {
      // In MySQL, schemas and databases are the same thing
      sql += `CREATE DATABASE ${schemaCreationIfExists ? "IF NOT EXISTS " : ""}\`${schema}\`;`;
    }

    return sql;
  };

export type GenerateSchemaCreationSQL = ReturnType<typeof generateSchemaCreationSQL>;

export const generateSchemaCreationMSSQL = generateSchemaCreationSQL("mssql");
export const generateSchemaCreationPostgreSQL = generateSchemaCreationSQL("pg");
export const generateSchemaCreationMySQL = generateSchemaCreationSQL("mysql");

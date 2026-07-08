import type { DatabaseType } from "../../../types/configuration";
import type { View } from "../../../types/db";

import { generateSchemaCreationSQL } from "../generateSchemaCreation";
import { convertMSSQLViewToPostgres } from "../mssqlToPostgres/convertView";
import { splitInternalName } from "../utils";

export type GenerateCreateViewSQLParameters = {
  schemaCreation?: boolean;
  schemaCreationIfExists?: boolean;
  viewCreationIfExists?: boolean;
  replaceExisting?: boolean;
};

const transformViewDefinition = (definition: string, toDb: DatabaseType): string => {
  if (toDb === "pg") return convertMSSQLViewToPostgres(definition);

  return (
    definition
      // Remove CREATE VIEW [...] AS part if present
      .replace(/CREATE\s+VIEW\s+.*?AS\s+/i, "")
      .trim()
  );
};

export const generateCreateViewSQL =
  (toDb: DatabaseType) =>
  (
    view: View,
    {
      schemaCreation = true,
      schemaCreationIfExists = true,
      viewCreationIfExists = true,
      replaceExisting = false,
    }: GenerateCreateViewSQLParameters = {},
  ) => {
    let sql = "";
    const parsed = splitInternalName(view.name, true);

    if (!parsed) return "";

    // Schema creation if needed
    if (schemaCreation) {
      sql += generateSchemaCreationSQL(toDb)(parsed.schema, schemaCreationIfExists);
      sql += "\n\n";
    }

    const transformedDefinition = transformViewDefinition(view.definition, toDb);

    // View creation
    if (toDb === "pg") {
      if (replaceExisting) {
        sql += `DROP VIEW IF EXISTS "${parsed.schema}"."${parsed.name}";\n`;
        sql += `CREATE VIEW "${parsed.schema}"."${parsed.name}" AS\n${transformedDefinition};`;
      } else if (viewCreationIfExists) {
        sql += `CREATE OR REPLACE VIEW "${parsed.schema}"."${parsed.name}" AS\n${transformedDefinition};`;
      }
    } else if (toDb === "mssql") {
      if (viewCreationIfExists || replaceExisting) {
        sql += `IF EXISTS (SELECT * FROM sys.views WHERE object_id = OBJECT_ID('${parsed.nameDotted}'))\n`;
        if (replaceExisting) {
          sql += `  DROP VIEW ${parsed.nameDotted};\n`;
        } else {
          sql += `  RETURN;\n`;
        }
      }
      sql += `CREATE VIEW ${parsed.nameDotted} AS\n${transformedDefinition};`;
    }

    return sql;
  };

export type GenerateCreateViewSQL = ReturnType<typeof generateCreateViewSQL>;

export const generateCreateViewMSSQL = generateCreateViewSQL("mssql");
export const generateCreateViewPostgreSQL = generateCreateViewSQL("pg");

export const generateCreateViewsSQL =
  (dbType: DatabaseType) => (views: View[], options?: GenerateCreateViewSQLParameters) => {
    const schemas = [...new Set(views.map((view) => splitInternalName(view.name)?.schema))].filter(
      Boolean,
    ) as string[];

    return [
      ...schemas.map((schema) => generateSchemaCreationSQL(dbType)(schema)),
      views
        .map((view) =>
          generateCreateViewSQL(dbType)(view, {
            ...options,
            schemaCreation: false,
          }),
        )
        .join("\n\n"),
    ].join("\n\n");
  };

export type GenerateCreateViewsSQL = ReturnType<typeof generateCreateViewsSQL>;

export const generateCreateViewsMSSQL = generateCreateViewsSQL("mssql");
export const generateCreateViewsPostgreSQL = generateCreateViewsSQL("pg");
export const generateCreateViewsMySQL = generateCreateViewsSQL("mysql");

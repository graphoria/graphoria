import type { Database, DatabaseType } from "../../types/configuration";
import type { DatabaseStructure, View } from "../../types/db";
import type { GenerateCreateTablesSQL } from "./generateCreateTable";
import type { GenerateCreateViewsSQL } from "./generateCreateView";
import type { GenerateInsertSQL } from "./generateInsert";

import { buildTableResolver, getDatabaseStructure, getViewsFromDB } from "..";
import { generateCreateTablesSQL } from "./generateCreateTable";
import {
  generateCreateViewsMSSQL,
  generateCreateViewsMySQL,
  generateCreateViewsPostgreSQL,
} from "./generateCreateView";
import {
  generateInsertSQLMSSQL,
  generateInsertSQLMySQL,
  generateInsertSQLPostgreSQL,
} from "./generateInsert";

const mapping: Record<
  DatabaseType,
  {
    getTablesFromDB: (db: Database) => Promise<DatabaseStructure>;
    getViewsFromDB: (db: Database) => Promise<View[]>;
    generateCreateTablesSQL: GenerateCreateTablesSQL;
    generateCreateViewsSQL: GenerateCreateViewsSQL;
    generateInsertsSQL: GenerateInsertSQL;
  }
> = {
  mssql: {
    getTablesFromDB: getDatabaseStructure,
    getViewsFromDB: getViewsFromDB,
    generateCreateTablesSQL,
    generateCreateViewsSQL: generateCreateViewsMSSQL,
    generateInsertsSQL: generateInsertSQLMSSQL,
  },
  pg: {
    getTablesFromDB: getDatabaseStructure,
    getViewsFromDB: getViewsFromDB,
    generateCreateTablesSQL,
    generateCreateViewsSQL: generateCreateViewsPostgreSQL,
    generateInsertsSQL: generateInsertSQLPostgreSQL,
  },
  mysql: {
    getTablesFromDB: getDatabaseStructure,
    getViewsFromDB: getViewsFromDB,
    generateCreateTablesSQL,
    generateCreateViewsSQL: generateCreateViewsMySQL,
    generateInsertsSQL: generateInsertSQLMySQL,
  },
};

const convertDatabase = async (
  dbFrom: Database,
  dbToType: DatabaseType,
  tables: "ALL" | string[] = "ALL",
) => {
  const databaseFrom = mapping[dbFrom.type];
  const databaseTo = mapping[dbToType];

  const dbTo: Database = {
    ...dbFrom,
    type: dbToType,
    name: `${dbFrom.name}_converted_to_${dbToType}`,
  };

  const fromTable = await databaseFrom.getTablesFromDB(dbFrom);
  // const fromViews = await databaseFrom.getViewsFromDB(ciFrom);

  const tablesToConvert =
    tables === "ALL"
      ? fromTable.tables
      : fromTable.tables.filter((table) => tables.includes(table.name));

  const convertedTables = databaseTo.generateCreateTablesSQL(dbTo, tablesToConvert);
  // const convertedViews = databaseTo.generateCreateViewsSQL(fromViews);

  const inserts = tablesToConvert.map((t) =>
    databaseTo.generateInsertsSQL(buildTableResolver(fromTable.tables, t, dbFrom), [
      {
        product_id: 1,
        sku: "ELEC-001",
        name: "Wireless Keyboard",
        description: "Ergonomic wireless keyboard",
        price: 49.99,
        is_active: 1,
      },
      {
        product_id: 2,
        sku: "ELEC-002",
        name: "USB-C Hub",
        description: "7-port USB-C hub",
        price: 29.99,
        is_active: 1,
      },
    ]),
  );

  return [convertedTables, inserts].join("\n\n");
};

await Bun.write(
  "converted.sql",
  await convertDatabase(
    {
      enabled: true,
      name: "default",
      type: "mssql",
      connection: {
        host: "localhost",
        port: 1433,
        user: "test",
        password: "test",
        database: "test",
      },
      fieldNaming: "{schema}_{name}",
    },
    "pg",
    ["products"],
  ),
);

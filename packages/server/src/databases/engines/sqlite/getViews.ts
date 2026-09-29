import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { Database } from "../../../types/configuration";
import type { View } from "../../../types/db";

import { databasesConnections } from "../../../singletons/databases";
import { wrapIdentifierSQLite } from "../../common";
import { openDatabase, schemasOf } from "./connection";

// The live connection when the server has one, matching getStructure.ts: see
// its comment for why a `:memory:` database needs this.
export const getViewsFromDB = async (db: Database): Promise<View[]> => {
  const existing = databasesConnections[db.name] as SQLiteDatabase | undefined;
  const connection = existing ?? openDatabase(db);

  try {
    return schemasOf(db).flatMap((schema) =>
      (
        connection
          .query(
            `SELECT name, sql AS definition FROM ${wrapIdentifierSQLite(schema)}.sqlite_schema WHERE type = 'view' ORDER BY name`,
          )
          .all() as Omit<View, "schema">[]
      ).map((view) => ({ schema, ...view })),
    );
  } finally {
    if (!existing) connection.close();
  }
};

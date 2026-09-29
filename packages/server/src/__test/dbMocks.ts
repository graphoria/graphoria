import type { Database, DatabaseType } from "../types/configuration";

export const createDbMock = (dbType: DatabaseType): Database =>
  dbType === "sqlite"
    ? {
        name: "default",
        enabled: true,
        type: dbType,
        connection: { filename: ":memory:" },
        fieldNaming: "{schema}_{name}",
      }
    : {
        name: "default",
        enabled: true,
        type: dbType,
        connection: {
          host: "localhost",
          port: 0,
          user: "test",
          password: "test",
          database: "test",
        },
        fieldNaming: "{schema}_{name}",
      };

export const dbMSSQL = createDbMock("mssql");
export const dbPostgreSQL = createDbMock("pg");
export const dbMySQL = createDbMock("mysql");
export const dbSQLite = createDbMock("sqlite");

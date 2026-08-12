import { SQL } from "bun";

import type { ConnectionPool } from "mssql";
import type { Database } from "../types/configuration.ts";

import { getPool as getPoolMSSQL } from "../databases/engines/mssql/connection.ts";
import { getPool as getPoolMySQL } from "../databases/engines/mysql/connection.ts";
import { getPool as getPoolPostgreSQL } from "../databases/engines/postgresql/connection.ts";

/**
 * Type for database connections mapping
 * Keys are database names from configuration, values are connection pools
 */
export type DatabasesConnections = Record<string, SQL | ConnectionPool>;

/**
 * Type for custom repository mapping
 * Keys are database names from configuration, values are the result of repository factory
 */
export type RepositoryMap<TRepository = unknown> = Record<string, TRepository>;

export const databasesConnections: DatabasesConnections = {};
export const repositoryMap: RepositoryMap = {};

export const instantiateDatabasesConnections = async (databases: Database[]) => {
  for await (const db of databases) {
    let connection: SQL | ConnectionPool | undefined;

    if (db.type === "pg") {
      connection = await getPoolPostgreSQL(db);
      databasesConnections[db.name] = connection;
    } else if (db.type === "mssql") {
      connection = await getPoolMSSQL(db);
      databasesConnections[db.name] = connection;
    } else if (db.type === "mysql") {
      connection = await getPoolMySQL(db);
      databasesConnections[db.name] = connection;
    }

    if (connection && db.onConnect) {
      await db.onConnect(connection, db);
    }

    // Initialize custom repository if factory is provided
    if (connection && db.repository) {
      repositoryMap[db.name] = db.repository(connection);
    }
  }

  return { databasesConnections, repositoryMap };
};

/**
 * Close every open database connection and clear the singleton maps. Bun's `SQL`
 * and mssql's `ConnectionPool` both expose `close()`. Used by
 * `createGraphQLEngine`'s `close()` so an in-process consumer can release
 * connections without a running server.
 */
export const disconnectDatabases = async () => {
  await Promise.all(Object.values(databasesConnections).map((connection) => connection.close()));

  for (const name of Object.keys(databasesConnections)) {
    delete databasesConnections[name];
  }
  for (const name of Object.keys(repositoryMap)) {
    delete repositoryMap[name];
  }
};

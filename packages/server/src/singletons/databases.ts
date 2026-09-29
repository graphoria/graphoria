import { SQL } from "bun";

import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { ConnectionPool } from "mssql";
import type { Database } from "../types/configuration.ts";

import { getPool as getPoolMSSQL } from "../databases/engines/mssql/connection.ts";
import { getPool as getPoolMySQL } from "../databases/engines/mysql/connection.ts";
import { getPool as getPoolPostgreSQL } from "../databases/engines/postgresql/connection.ts";
import { getPool as getPoolSQLite } from "../databases/engines/sqlite/connection.ts";
import { logger } from "../logging";

/**
 * Type for database connections mapping
 * Keys are database names from configuration, values are connection pools
 */
export type DatabasesConnections = Record<string, SQL | ConnectionPool | SQLiteDatabase>;

/**
 * Type for custom repository mapping
 * Keys are database names from configuration, values are the result of repository factory
 */
export type RepositoryMap<TRepository = unknown> = Record<string, TRepository>;

export const databasesConnections: DatabasesConnections = {};
export const repositoryMap: RepositoryMap = {};

const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;

export type RetryClock = { now(): number; sleep(ms: number): Promise<unknown> };

const systemClock: RetryClock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/**
 * Keeps calling `connect` until it resolves or `deadline` passes, backing off
 * 1 s → 30 s. The last wait is cut short so one final attempt runs at the
 * deadline. The last error is rethrown.
 */
export const connectWithRetry = async <T>(
  name: string,
  connect: () => Promise<T>,
  deadline: number,
  clock: RetryClock = systemClock,
): Promise<T> => {
  let delay = RETRY_INITIAL_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error) {
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw error;
      const wait = Math.min(delay, remaining);
      logger("db").warn(
        { database: name, attempt, retryInMs: wait, err: error },
        "database connect failed, retrying",
      );
      await clock.sleep(wait);
      delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
    }
  }
};

export const instantiateDatabasesConnections = async (
  databases: Database[],
  retryMs = 0,
  clock: RetryClock = systemClock,
) => {
  // One deadline for every database, so the whole connect phase has one budget.
  const deadline = clock.now() + retryMs;

  for await (const db of databases) {
    let connection: SQL | ConnectionPool | SQLiteDatabase | undefined;

    if (db.type === "pg") {
      connection = await connectWithRetry(db.name, () => getPoolPostgreSQL(db), deadline, clock);
      databasesConnections[db.name] = connection;
    } else if (db.type === "mssql") {
      connection = await connectWithRetry(db.name, () => getPoolMSSQL(db), deadline, clock);
      databasesConnections[db.name] = connection;
    } else if (db.type === "mysql") {
      connection = await connectWithRetry(db.name, () => getPoolMySQL(db), deadline, clock);
      databasesConnections[db.name] = connection;
    } else if (db.type === "sqlite") {
      // Not retried: a file that does not open (a missing directory, permissions,
      // the version floor) fails the same way on every attempt.
      connection = await getPoolSQLite(db);
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

export const pingConnection = async (connection: DatabasesConnections[string], type: string) => {
  if (type === "mssql") return (connection as ConnectionPool).query("SELECT 1");
  if (type === "sqlite") return (connection as SQLiteDatabase).query("SELECT 1").get();
  return (connection as SQL).unsafe("SELECT 1");
};

/**
 * Close every open database connection and clear the singleton maps. Bun's `SQL`,
 * mssql's `ConnectionPool` and bun:sqlite's `Database` all expose `close()`. Used by
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

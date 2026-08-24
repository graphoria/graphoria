import { SQL } from "bun";

import type { BunSQLConnectionOptions } from "../../../config";
import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";
import type { ProcedureResolver } from "../../../types/db";

import { databasesConnections } from "../../../singletons/databases";
import { toMySQLPlaceholders } from "./placeholders";

export const getPool = async (db: Database) => {
  const opts = db.connectionOptions as BunSQLConnectionOptions | undefined;
  const pool = new SQL({
    host: db.connection.host,
    port: db.connection.port,
    username: db.connection.user,
    password: db.connection.password,
    database: db.connection.database,
    adapter: "mysql",
    max: opts?.max ?? 50,
    idleTimeout: opts?.idleTimeout ?? 30,
    connectionTimeout: opts?.connectionTimeout,
    maxLifetime: opts?.maxLifetime,
    tls: opts?.tls,
    allowPublicKeyRetrieval: opts?.allowPublicKeyRetrieval,
    prepare: opts?.prepare,
    bigint: opts?.bigint,
  });

  await pool.connect(); // Connect to the database

  return pool;
};

export const getPoolSingleton = async (db: Database) => databasesConnections[db.name] as SQL;

export const executeQueryFactory =
  (singleQuery = false) =>
  async <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[] = [],
    values: Record<string, unknown> = {},
  ) => {
    const pool = singleQuery ? await getPool(db) : await getPoolSingleton(db);

    // Bun's MySQL adapter binds `?` positionally; the builders emit `$n`.
    const bound = toMySQLPlaceholders(query, variablesDefinition, values);

    const result = await pool.unsafe<T>(bound.query, bound.params);

    if (singleQuery) {
      await pool.close();
    }

    return result;
  };

export const executeQuery = executeQueryFactory();
export const executeQuerySingle = executeQueryFactory(true);

export const executeQueryJSONFactory =
  (singleQuery = false) =>
  async <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[] = [],
    values: Record<string, unknown> = {},
  ) => {
    const result = await (singleQuery ? executeQuerySingle : executeQuery)<[{ json_result: T }]>(
      query,
      db,
      variablesDefinition,
      values,
    );

    return result[0].json_result as T;
  };

export const executeQueryJSON = executeQueryJSONFactory();
export const executeQueryJSONSingle = executeQueryJSONFactory(true);

export const callStoredProcedure = async (
  sp: ProcedureResolver,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown>,
) => {
  try {
    const data = await executeQuery(
      `CALL ${sp.dottedQuotedName}(${Object.keys(variables)
        .map((_, i) => `$${i + 1}`)
        .join(", ")});`,
      sp.db!,
      variablesDefinition,
      variables,
    );

    return data;
  } catch {
    return false;
  }
};

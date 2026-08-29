import { SQL } from "bun";

import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";
import type { ProcedureResolver } from "../../../types/db";

import { BunSQLConnectionOptionsZod } from "../../../config/types/db";
import { databasesConnections } from "../../../singletons/databases";

// Every pool bound comes from the schema, which is the only place they are
// declared and documented. Repeating them here as `?? n` fallbacks let the
// documented default and the applied one drift apart, differently per engine.
export const poolOptions = (db: Database) => {
  const opts = BunSQLConnectionOptionsZod.parse(db.connectionOptions ?? {});

  return {
    host: db.connection.host,
    port: db.connection.port,
    user: db.connection.user,
    password: db.connection.password,
    database: db.connection.database,
    max: opts.max,
    idleTimeout: opts.idleTimeout,
    connectionTimeout: opts.connectionTimeout,
    maxLifetime: opts.maxLifetime,
    tls: opts.tls,
    prepare: opts.prepare,
    bigint: opts.bigint,
  };
};

export const getPool = async (db: Database) => {
  const pool = new SQL(poolOptions(db));

  await pool.connect(); // Connect to the database

  return pool;
};

export const getPoolSingleton = async (db: Database) => databasesConnections[db.name] as SQL;

export const executeQueryFactory =
  (singleQuery = false) =>
  async <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[],
    values: Record<string, unknown> = {},
  ) => {
    const pool = singleQuery ? await getPool(db) : await getPoolSingleton(db);

    const result = await pool.unsafe<T>(
      query,
      variablesDefinition.map((v) => values[v.name]),
    );

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
      `SELECT * FROM ${sp.dottedQuotedName}(${Object.keys(variables)
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

import { SQL } from "bun";

import type { BunSQLConnectionOptions } from "../../../config";
import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";
import type { ProcedureResolver } from "../../../types/db";

import { BunSQLConnectionOptionsZod } from "../../../config/types/db";
import { databasesConnections } from "../../../singletons/databases";
import { toMySQLPlaceholders } from "./placeholders";

// Every pool bound comes from the schema, which is the only place they are
// declared and documented. Repeating them here as `?? n` fallbacks let the
// documented default and the applied one drift apart, differently per engine.
//
// Defaults are overlaid rather than re-parsed: `connectionOptions` is an
// undiscriminated union of the two engine shapes, so an object can arrive
// already validated against the other one, and a strict re-parse would reject
// it at boot.
export const poolOptions = (db: Database) => {
  const opts = {
    ...BunSQLConnectionOptionsZod.parse({}),
    ...(db.connectionOptions as BunSQLConnectionOptions | undefined),
  };

  return {
    host: db.connection.host,
    port: db.connection.port,
    username: db.connection.user,
    password: db.connection.password,
    database: db.connection.database,
    adapter: "mysql" as const,
    max: opts.max,
    idleTimeout: opts.idleTimeout,
    connectionTimeout: opts.connectionTimeout,
    maxLifetime: opts.maxLifetime,
    tls: opts.tls,
    allowPublicKeyRetrieval: opts.allowPublicKeyRetrieval,
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

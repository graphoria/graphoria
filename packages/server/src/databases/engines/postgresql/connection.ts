import { SQL } from "bun";

import type { BunSQLConnectionOptions } from "../../../config";
import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";
import type { ProcedureResolver } from "../../../types/db";

import { BunSQLConnectionOptionsZod } from "../../../config/types/db";
import { databasesConnections } from "../../../singletons/databases";
import { orderProcedureArguments } from "../../core/procedure-arguments";
import { getQueryTimeoutMs } from "../../../singletons/queryTimeout";

// Every pool bound comes from the schema, which is the only place they are
// declared and documented. Repeating them here as `?? n` fallbacks let the
// documented default and the applied one drift apart, differently per engine.
//
// Defaults are overlaid rather than re-parsed: `connectionOptions` is an
// undiscriminated union of the two engine shapes, so an object can arrive
// already validated against the other one, and a strict re-parse would reject
// it at boot.
export const poolOptions = (db: Database, timeoutMs: number = getQueryTimeoutMs()) => {
  const opts = {
    ...BunSQLConnectionOptionsZod.parse({}),
    ...(db.connectionOptions as BunSQLConnectionOptions | undefined),
  };

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
    // Applied once per pooled connection rather than per query, so it bounds
    // everything that runs on the connection — auth and introspection included
    // — at no per-query cost. Omitted at 0 rather than sent as "0", which
    // Postgres reads as unlimited but still costs a round trip to set.
    ...(timeoutMs > 0 ? { connection: { statement_timeout: String(timeoutMs) } } : {}),
  };
};

/** The bound the pool already applies, so the executor can tell an override from the default. */
export const poolStatementTimeoutMs = (db: Database) =>
  Number(poolOptions(db).connection?.statement_timeout ?? 0);

export const getPool = async (db: Database) => {
  const pool = new SQL(poolOptions(db));

  await pool.connect(); // Connect to the database

  return pool;
};

export const getPoolSingleton = async (db: Database) => databasesConnections[db.name] as SQL;

// A timeout other than the pool's own has to be set on a connection, which
// means pinning one for the duration. Only an override pays for that.
const executeReserved = async <T>(
  pool: SQL,
  timeoutMs: number,
  query: string,
  params: unknown[],
) => {
  // SET takes no bind parameters, so the value is interpolated. It is an
  // integer from the config schema; re-checked here so a widened type upstream
  // cannot turn this line into an injection point.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error(`Invalid statement timeout: ${timeoutMs}`);
  }

  const reserved = await pool.reserve();

  try {
    await reserved.unsafe(`SET statement_timeout = ${timeoutMs}`);

    return await reserved.unsafe<T>(query, params);
  } finally {
    // The connection goes back to the pool carrying the pool's default again,
    // not this query's override.
    await reserved.unsafe("RESET statement_timeout");
    await reserved.release();
  }
};

export const executeQueryFactory =
  (singleQuery = false) =>
  async <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[],
    values: Record<string, unknown> = {},
    timeoutMs?: number,
  ) => {
    const pool = singleQuery ? await getPool(db) : await getPoolSingleton(db);
    const params = variablesDefinition.map((v) => values[v.name]);

    const override = timeoutMs !== undefined && timeoutMs !== poolStatementTimeoutMs(db);

    const result = override
      ? await executeReserved<T>(pool, timeoutMs, query, params)
      : await pool.unsafe<T>(query, params);

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
    timeoutMs?: number,
  ) => {
    const result = await (singleQuery ? executeQuerySingle : executeQuery)<[{ json_result: T }]>(
      query,
      db,
      variablesDefinition,
      values,
      timeoutMs,
    );

    return result[0].json_result as T;
  };

export const executeQueryJSON = executeQueryJSONFactory();
export const executeQueryJSONSingle = executeQueryJSONFactory(true);

export const callStoredProcedure = async (
  sp: ProcedureResolver,
  variables: Record<string, unknown>,
) => {
  try {
    const args = orderProcedureArguments(sp, variables);

    const data = await executeQuery(
      `SELECT * FROM ${sp.dottedQuotedName}(${args.map((_, i) => `$${i + 1}`).join(", ")});`,
      sp.db!,
      args,
      variables,
    );

    return data;
  } catch {
    return false;
  }
};

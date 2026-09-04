import { isString } from "es-toolkit";
import { ConnectionPool, Decimal, Int, NVarChar, Numeric, VarChar } from "mssql";

import type { MSSQLConnectionOptions } from "../../../config";
import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";
import type { ProcedureResolver } from "../../../types/db";

import { MSSQLConnectionOptionsZod } from "../../../config/types/db";
import { databasesConnections } from "../../../singletons/databases";
import { getQueryTimeoutMs } from "../../../singletons/queryTimeout";
import { logger } from "../../../logging";

// Every pool bound comes from the schema, which is the only place they are
// declared and documented. Repeating them here as `?? n` fallbacks let the
// documented default and the applied one drift apart, differently per engine.
//
// Defaults are overlaid rather than re-parsed: `connectionOptions` is an
// undiscriminated union of the two engine shapes, and an object carrying
// nothing MSSQL-specific — `{}` included — validates against the Bun SQL shape
// even on an MSSQL database. A strict re-parse of one of those would reject the
// Bun SQL keys and take the server down at boot.
export const poolOptions = (db: Database, timeoutMs: number = getQueryTimeoutMs()) => {
  const ci = db.connection;
  const raw = db.connectionOptions as MSSQLConnectionOptions | undefined;

  const defaults = MSSQLConnectionOptionsZod.parse({});
  const opts = { ...defaults, ...raw, pool: { ...defaults.pool, ...raw?.pool } };

  return {
    server: ci.host,
    port: ci.port,
    user: ci.user,
    password: ci.password,
    database: ci.database,
    connectionTimeout: opts.connectionTimeout * 1000,
    // Only an omitted key falls through to the resolved timeout: reading it off
    // `opts` cannot tell an operator who set 30 from Zod defaulting to 30, and
    // silently overriding the first would break the slow report it was raised
    // for. Seconds there, milliseconds here.
    requestTimeout: raw?.requestTimeout !== undefined ? raw.requestTimeout * 1000 : timeoutMs,
    // These three keep their code fallbacks rather than the schema's. Two of
    // them default the opposite way there, so taking the schema value would
    // turn certificate validation on and trusted connections off for every
    // deployment that omits `connectionOptions` — a change to how a connection
    // is secured, not to how the pool is sized.
    options: {
      encrypt: raw?.encrypt ?? false,
      trustServerCertificate: raw?.trustServerCertificate ?? true,
      trustedConnection: raw?.trustedConnection ?? true,
    },
    pool: {
      max: opts.pool.max,
      min: opts.pool.min,
      idleTimeoutMillis: opts.pool.idleTimeout * 1000,
      acquireTimeoutMillis: opts.pool.acquireTimeout * 1000,
    },
    parseJSON: opts.parseJSON,
  };
};

/** The bound the pool already applies, so the executor can tell an override from the default. */
export const poolRequestTimeoutMs = (db: Database) => poolOptions(db).requestTimeout;

// `ConnectionPool.request` takes per-request overrides from mssql 12.7.0, which
// is what the workspace pins, but `@types/mssql@12.3.0` still declares it with
// no parameter. Narrowed to the one key used rather than cast wholesale, so the
// day the types catch up this stops compiling and can be deleted.
//
// Not interchangeable with assigning `request.timeout`: that property does not
// exist, and the pool default is used instead.
type PoolWithRequestOverrides = {
  request(overrides: { requestTimeout: number }): ReturnType<ConnectionPool["request"]>;
};

const requestWithTimeout = (pool: ConnectionPool, timeoutMs: number) =>
  (pool as unknown as PoolWithRequestOverrides).request({ requestTimeout: timeoutMs });

export const getPool = async (db: Database) => {
  const pool = new ConnectionPool(poolOptions(db));

  await pool.connect(); // Connect to the database

  while (!pool.connected) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return pool;
};

export const getPoolSingleton = async (db: Database) =>
  databasesConnections[db.name] as ConnectionPool;

export const executeQueryFactory =
  (singleQuery = false) =>
  async <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[] = [],
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ) => {
    const pool = singleQuery ? await getPool(db) : await getPoolSingleton(db);

    while (!pool!.connected) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const request =
      timeoutMs !== undefined && timeoutMs !== poolRequestTimeoutMs(db)
        ? requestWithTimeout(pool!, timeoutMs)
        : pool!.request();

    variablesDefinition.forEach((v, i) => {
      const varName = (i + 1).toString();
      const varValue = params[v.name];

      if (isString(varValue)) {
        request.input(varName, VarChar, varValue);
      } else if (typeof varValue === "number") {
        request.input(varName, Int, varValue);
      } else if (typeof varValue === "boolean") {
        request.input(varName, Int, varValue ? 1 : 0);
      }
    });

    const result = await request.query<T>(query);

    if (singleQuery) {
      await pool.close();
    }

    return result.recordset;
  };

export const executeQuery = executeQueryFactory();
export const executeQuerySingle = executeQueryFactory(true);

export const executeQueryJSONFactory =
  (singleQuery = false) =>
  async <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[] = [],
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> => {
    const result = await (singleQuery ? executeQuerySingle : executeQuery)(
      query,
      db,
      variablesDefinition,
      params,
      timeoutMs,
    );

    return result[0] as T;
  };

export const executeQueryJSON = executeQueryJSONFactory();
export const executeQueryJSONSingle = executeQueryJSONFactory(true);

export const callStoredProcedure = async (
  sp: ProcedureResolver,
  variables: Record<string, unknown> = {},
) => {
  try {
    const pool = await getPoolSingleton(sp.db!);

    const request = pool!.request();

    for (const [key, value] of Object.entries(variables)) {
      const paramFound = sp.parameters.find((p) => p.name === `@${key}`);

      if (paramFound?.dataType === "varchar") {
        request.input(key, VarChar(paramFound.maxLength), value);
      } else if (paramFound?.dataType === "nvarchar") {
        request.input(
          key,
          paramFound.maxLength > -1 ? NVarChar(paramFound.maxLength) : NVarChar(),
          value,
        );
      } else if (paramFound?.dataType === "numeric") {
        request.input(key, Numeric(paramFound.precision, paramFound.scale), value);
      } else if (paramFound?.dataType === "decimal") {
        request.input(key, Decimal(paramFound.precision, paramFound.scale), value);
      } else if (paramFound?.dataType === "int") {
        request.input(key, Int, value);
      } else {
        request.input(key, value);
      }
    }

    // Unquoted on purpose: tedious sends this as the TDS RPC procedure name,
    // never as SQL text, so reserved words need no delimiting here.
    const data = await request.execute(sp.dottedName);

    return !data?.returnValue;
  } catch (e: unknown) {
    logger("mssql").error({ err: e }, "stored procedure execution failed");
    return false;
  }
};

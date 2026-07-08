import { isString } from "es-toolkit";
import { ConnectionPool, Decimal, Int, NVarChar, Numeric, VarChar } from "mssql";

import type { MSSQLConnectionOptions } from "../../../config";
import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";
import type { ProcedureResolver } from "../../../types/db";

import { databasesConnections } from "../../../singletons/databases";
import { logger } from "../../../logging";

export const getPool = async (db: Database) => {
  const ci = db.connection;
  const opts = db.connectionOptions as MSSQLConnectionOptions | undefined;
  const pool = new ConnectionPool({
    server: ci.host,
    port: ci.port,
    user: ci.user,
    password: ci.password,
    database: ci.database,
    connectionTimeout: opts?.connectionTimeout ? opts.connectionTimeout * 1000 : undefined,
    requestTimeout: opts?.requestTimeout ? opts.requestTimeout * 1000 : undefined,
    options: {
      encrypt: opts?.encrypt ?? false,
      trustServerCertificate: opts?.trustServerCertificate ?? true,
      trustedConnection: opts?.trustedConnection ?? true,
    },
    pool: {
      max: opts?.pool?.max ?? 50,
      min: opts?.pool?.min ?? 1,
      idleTimeoutMillis: (opts?.pool?.idleTimeout ?? 30) * 1000,
    },
    parseJSON: opts?.parseJSON ?? true,
  });

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
  ) => {
    const pool = singleQuery ? await getPool(db) : await getPoolSingleton(db);

    while (!pool!.connected) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const request = pool!.request();

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
  ): Promise<T> => {
    const result = await (singleQuery ? executeQuerySingle : executeQuery)(
      query,
      db,
      variablesDefinition,
      params,
    );

    return result[0] as T;
  };

export const executeQueryJSON = executeQueryJSONFactory();
export const executeQueryJSONSingle = executeQueryJSONFactory(true);

export const callStoredProcedure = async (
  sp: ProcedureResolver,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown> = {},
) => {
  try {
    const pool = await getPoolSingleton(sp.db!);

    const request = pool!.request();

    for (const [key, value] of Object.entries(variables)) {
      if (!value) continue;

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

    const data = await request.execute(sp.dottedName);

    return data?.recordset ?? false;
  } catch (e: unknown) {
    logger("mssql").error({ err: e }, "stored procedure execution failed");
    return false;
  }
};

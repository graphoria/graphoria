import type { VariableDefinition } from "../../analyzeQuery/types";
import type { Database } from "../../types/configuration";
import type { ProcedureResolver } from "../../types/db";

import { databaseAdapters } from "./function-mapping";
import { logger } from "../../logging";

/**
 * Core database execution functions
 */

export const executeQuery = async <T>(
  query: string,
  db: Database,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown>,
) => {
  const adapter = databaseAdapters[db?.type];
  if (!adapter) {
    throw new Error(`Unsupported database type: ${db?.type}`);
  }

  const log = logger("db").child({ dbType: db.type, dbName: db.name });
  const startTime = Bun.nanoseconds();

  try {
    const result = await adapter.execute<T>(query, db, variablesDefinition, variables);
    log.debug(
      { durationMs: (Bun.nanoseconds() - startTime) / 1e6, queryLength: query.length },
      "query executed",
    );
    return result;
  } catch (error) {
    log.error({ err: error, durationMs: (Bun.nanoseconds() - startTime) / 1e6 }, "query failed");
    throw error;
  }
};

export const executeQueryJSON = async <T>(
  query: string,
  db: Database,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown>,
) => {
  const adapter = databaseAdapters[db.type];
  if (!adapter) {
    throw new Error(`Unsupported database type: ${db.type}`);
  }

  const log = logger("db").child({ dbType: db.type, dbName: db.name });
  const startTime = Bun.nanoseconds();

  try {
    const result = await adapter.executeJson<T>(query, db, variablesDefinition, variables);
    log.debug(
      { durationMs: (Bun.nanoseconds() - startTime) / 1e6, queryLength: query.length },
      "query executed (json)",
    );
    return result;
  } catch (error) {
    log.error(
      { err: error, durationMs: (Bun.nanoseconds() - startTime) / 1e6 },
      "query failed (json)",
    );
    throw error;
  }
};

export const callStoredProcedure = async (
  sp: ProcedureResolver,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown> = {},
) => {
  const adapter = databaseAdapters[sp.db!.type];
  if (!adapter) {
    throw new Error(`Unsupported database type: ${sp.db!.type}`);
  }

  const log = logger("db").child({
    dbType: sp.db!.type,
    dbName: sp.db!.name,
    procedure: sp.dottedName,
  });
  const startTime = Bun.nanoseconds();

  try {
    const result = await adapter.callStoredProcedure(sp, variablesDefinition, variables);
    log.debug({ durationMs: (Bun.nanoseconds() - startTime) / 1e6 }, "stored procedure executed");
    return result;
  } catch (error) {
    log.error(
      { err: error, durationMs: (Bun.nanoseconds() - startTime) / 1e6 },
      "stored procedure failed",
    );
    throw error;
  }
};

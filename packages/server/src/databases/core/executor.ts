import type { VariableDefinition } from "../../analyzeQuery/types";
import type { QuerySource } from "../../logging/slowQuery";
import type { Database } from "../../types/configuration";
import type { ProcedureResolver } from "../../types/db";

import { databaseAdapters } from "./function-mapping";
import { logger } from "../../logging";
import { reportQueryDuration } from "../../logging/slowQuery";

/**
 * Core database execution functions
 */

export const executeQuery = async <T>(
  query: string,
  db: Database,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown>,
  /** Per-operation override. `undefined` leaves the engine on its own default. */
  timeoutMs?: number,
  source?: QuerySource,
) => {
  const adapter = databaseAdapters[db?.type];
  if (!adapter) {
    throw new Error(`Unsupported database type: ${db?.type}`);
  }

  const log = logger("db").child({ dbType: db.type, dbName: db.name });
  const startTime = Bun.nanoseconds();
  const report = (durationMs: number, outcome: "success" | "error") =>
    reportQueryDuration({
      durationMs,
      dbType: db.type,
      dbName: db.name,
      sql: query,
      outcome,
      ...source,
    });

  try {
    const result = await adapter.execute<T>(query, db, variablesDefinition, variables, timeoutMs);
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.debug({ durationMs, queryLength: query.length }, "query executed");
    report(durationMs, "success");
    return result;
  } catch (error) {
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.error({ err: error, durationMs }, "query failed");
    report(durationMs, "error");
    throw error;
  }
};

export const executeQueryJSON = async <T>(
  query: string,
  db: Database,
  variablesDefinition: VariableDefinition[],
  variables: Record<string, unknown>,
  /** Per-operation override. `undefined` leaves the engine on its own default. */
  timeoutMs?: number,
  source?: QuerySource,
) => {
  const adapter = databaseAdapters[db.type];
  if (!adapter) {
    throw new Error(`Unsupported database type: ${db.type}`);
  }

  const log = logger("db").child({ dbType: db.type, dbName: db.name });
  const startTime = Bun.nanoseconds();
  const report = (durationMs: number, outcome: "success" | "error") =>
    reportQueryDuration({
      durationMs,
      dbType: db.type,
      dbName: db.name,
      sql: query,
      outcome,
      ...source,
    });

  try {
    const result = await adapter.executeJson<T>(
      query,
      db,
      variablesDefinition,
      variables,
      timeoutMs,
    );
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.debug({ durationMs, queryLength: query.length }, "query executed (json)");
    report(durationMs, "success");
    return result;
  } catch (error) {
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.error({ err: error, durationMs }, "query failed (json)");
    report(durationMs, "error");
    throw error;
  }
};

export const callStoredProcedure = async (
  sp: ProcedureResolver,
  variables: Record<string, unknown> = {},
  source?: QuerySource,
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
  const report = (durationMs: number, outcome: "success" | "error") =>
    reportQueryDuration({
      durationMs,
      dbType: sp.db!.type,
      dbName: sp.db!.name,
      procedure: sp.dottedName,
      outcome,
      ...source,
    });

  try {
    const result = await adapter.callStoredProcedure(sp, variables);
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.debug({ durationMs }, "stored procedure executed");
    report(durationMs, "success");
    return result;
  } catch (error) {
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.error({ err: error, durationMs }, "stored procedure failed");
    report(durationMs, "error");
    throw error;
  }
};

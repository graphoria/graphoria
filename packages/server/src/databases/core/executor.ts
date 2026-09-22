import type { VariableDefinition } from "../../analyzeQuery/types";
import type { QuerySource } from "../../logging/slowQuery";
import type { Database } from "../../types/configuration";
import type { ProcedureResolver } from "../../types/db";

import { databaseAdapters } from "./function-mapping";
import { logger } from "../../logging";
import { reportQueryDuration } from "../../logging/slowQuery";
import { startSpan } from "../../observability/tracing";

/**
 * Core database execution functions
 */

/** Names only. The variable values are caller data and never reach a span. */
const sourceAttributes = (source?: QuerySource) => ({
  "graphql.operation.name": source?.operation.name ?? undefined,
  "graphql.operation.type": source?.operation.type,
  "graphoria.role": source?.role,
});

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
  // Every literal is hoisted into a bound parameter, so the statement text
  // carries no caller data and is safe to export.
  const span = startSpan("db.query", {
    kind: "client",
    attributes: {
      "db.system": db.type,
      "db.name": db.name,
      "db.statement": query,
      ...sourceAttributes(source),
    },
  });

  try {
    const result = await adapter.execute<T>(query, db, variablesDefinition, variables, timeoutMs);
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.debug({ durationMs, queryLength: query.length }, "query executed");
    report(durationMs, "success");
    span?.end();
    return result;
  } catch (error) {
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.error({ err: error, durationMs }, "query failed");
    report(durationMs, "error");
    span?.recordError(error);
    span?.end();
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
  const span = startSpan("db.query", {
    kind: "client",
    attributes: {
      "db.system": db.type,
      "db.name": db.name,
      "db.statement": query,
      ...sourceAttributes(source),
    },
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
    span?.end();
    return result;
  } catch (error) {
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.error({ err: error, durationMs }, "query failed (json)");
    report(durationMs, "error");
    span?.recordError(error);
    span?.end();
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
  const span = startSpan("db.procedure", {
    kind: "client",
    attributes: {
      "db.system": sp.db!.type,
      "db.name": sp.db!.name,
      "db.operation": sp.dottedName,
      ...sourceAttributes(source),
    },
  });

  try {
    const result = await adapter.callStoredProcedure(sp, variables);
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.debug({ durationMs }, "stored procedure executed");
    report(durationMs, "success");
    span?.end();
    return result;
  } catch (error) {
    const durationMs = (Bun.nanoseconds() - startTime) / 1e6;
    log.error({ err: error, durationMs }, "stored procedure failed");
    report(durationMs, "error");
    span?.recordError(error);
    span?.end();
    throw error;
  }
};

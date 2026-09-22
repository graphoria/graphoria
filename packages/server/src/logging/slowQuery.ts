import type { Logger } from "pino";

import { logger } from "./index";

/** The GraphQL operation a statement was generated for. Names only, never values. */
export type QuerySource = {
  operation: {
    type: "query" | "mutation" | "subscription";
    name: string | null;
    fields: string[];
  };
  role?: string | undefined;
};

export type SlowQueryRecord = {
  durationMs: number;
  dbType: string;
  dbName: string;
  sql?: string;
  procedure?: string;
  outcome: "success" | "error";
} & Partial<QuerySource>;

export type SlowQueryLog = {
  emit(record: SlowQueryRecord & { thresholdMs: number }): void;
};

/**
 * Resolved from `SLOW_QUERY_MS` at boot. `0` — also the value before boot sets
 * it — reports nothing, so an executor used outside a booted server stays quiet.
 */
let thresholdMs = 0;

export const setSlowQueryMs = (ms: number): void => {
  thresholdMs = ms;
};

export const createSlowQueryLog = (base: Logger): SlowQueryLog => ({
  emit: (record) => base.warn(record, "slow query"),
});

let override: SlowQueryLog | null = null;
let instance: SlowQueryLog | null = null;

/** Test seam: pass `null` to restore the default log. */
export const setSlowQueryLog = (log: SlowQueryLog | null): void => {
  override = log;
};

const slowQueryLog = (): SlowQueryLog => {
  if (override) return override;
  if (!instance) instance = createSlowQueryLog(logger("slow-query"));
  return instance;
};

export const reportQueryDuration = (record: SlowQueryRecord): void => {
  if (thresholdMs === 0 || record.durationMs <= thresholdMs) return;
  slowQueryLog().emit({ ...record, thresholdMs });
};

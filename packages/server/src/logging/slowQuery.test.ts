import { afterEach, describe, expect, it } from "bun:test";
import pino from "pino";

import type { SlowQueryRecord } from "./slowQuery";

import {
  createSlowQueryLog,
  reportQueryDuration,
  setSlowQueryLog,
  setSlowQueryMs,
} from "./slowQuery";

const record = (durationMs: number): SlowQueryRecord => ({
  durationMs,
  dbType: "pg",
  dbName: "main",
  sql: 'SELECT "id" FROM "public"."orders"',
  outcome: "success",
  operation: { type: "query", name: "RecentOrders", fields: ["orders"] },
  role: "user",
});

describe("createSlowQueryLog", () => {
  it("writes one warn record carrying the statement, the operation and the role", () => {
    const lines: string[] = [];
    const root = pino({ level: "info" }, { write: (line: string) => lines.push(line) });

    createSlowQueryLog(root).emit({ ...record(1500), thresholdMs: 1000 });

    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(written.level).toBe(pino.levels.values.warn);
    expect(written.msg).toBe("slow query");
    expect(written.sql).toBe('SELECT "id" FROM "public"."orders"');
    expect(written.operation).toEqual({ type: "query", name: "RecentOrders", fields: ["orders"] });
    expect(written.role).toBe("user");
    expect(written.durationMs).toBe(1500);
    expect(written.thresholdMs).toBe(1000);
  });
});

describe("reportQueryDuration", () => {
  const emitted: Array<SlowQueryRecord & { thresholdMs: number }> = [];

  const capture = () => {
    emitted.length = 0;
    setSlowQueryLog({ emit: (entry) => emitted.push(entry) });
  };

  afterEach(() => {
    setSlowQueryLog(null);
    setSlowQueryMs(0);
  });

  it("reports a statement that ran past the threshold, with the threshold it crossed", () => {
    capture();
    setSlowQueryMs(1000);

    reportQueryDuration(record(1000.5));

    expect(emitted).toEqual([{ ...record(1000.5), thresholdMs: 1000 }]);
  });

  it("stays silent for a statement at or under the threshold", () => {
    capture();
    setSlowQueryMs(1000);

    reportQueryDuration(record(999));
    reportQueryDuration(record(1000));

    expect(emitted).toHaveLength(0);
  });

  it("reports nothing when the threshold is 0, however long the statement ran", () => {
    capture();
    setSlowQueryMs(0);

    reportQueryDuration(record(60_000));

    expect(emitted).toHaveLength(0);
  });
});

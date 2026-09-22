import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { SlowQueryRecord } from "../../logging/slowQuery";
import type { StartedServer } from "./harness";

import { CONNECTIONS, fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";

/**
 * A statement that runs past `SLOW_QUERY_MS` is reported with the SQL that ran
 * and the GraphQL operation it was generated for, through the real boot path.
 * The view sleeps, so "slow" does not depend on the machine running the suite.
 *
 * PostgreSQL only: the executor the report lives in is engine-agnostic, and its
 * unit tests cover all three engines.
 */

const ENGINE = "pg" as const;
const THRESHOLD_MS = 100;
const probe = fieldName(ENGINE, "app", "slow_probe");
const procedure = fieldName(ENGINE, "app", "slow_proc");

describe.skipIf(!integrationEnabled)("slow query log", () => {
  let started: StartedServer;
  const records: Array<SlowQueryRecord & { thresholdMs: number }> = [];
  // oxlint-disable-next-line typescript/no-explicit-any
  let setSlowQueryLog: any;

  const recordFor = (name: string) => records.find((record) => record.operation?.name === name);

  beforeAll(async () => {
    // The view has to exist before boot introspects the schema, and after the
    // seed, which recreates the schema it lives in.
    await seedEngine(ENGINE);
    const raw = new SQL({
      hostname: CONNECTIONS.pg.host,
      port: CONNECTIONS.pg.port,
      username: CONNECTIONS.pg.user,
      password: CONNECTIONS.pg.password,
      database: CONNECTIONS.pg.database,
      max: 1,
    });
    await raw.unsafe(
      `CREATE VIEW app.slow_probe AS SELECT 1 AS id FROM (SELECT pg_sleep(0.3)) AS s`,
    );
    await raw.unsafe(
      `CREATE FUNCTION app.slow_proc() RETURNS TABLE (id integer)
       AS $$ SELECT 1 FROM (SELECT pg_sleep(0.3)) AS s $$ LANGUAGE sql`,
    );
    await raw.close();

    started = await startServer({
      engine: ENGINE,
      skipSeed: true,
      env: { slowQueryMs: THRESHOLD_MS },
    });

    ({ setSlowQueryLog } = await import("../../logging/slowQuery"));
    setSlowQueryLog({ emit: (record: (typeof records)[number]) => records.push(record) });
  });

  beforeEach(() => {
    records.length = 0;
  });

  afterAll(async () => {
    setSlowQueryLog?.(null);
    await started?.context.sql(`DROP VIEW IF EXISTS app.slow_probe`);
    await started?.context.sql(`DROP FUNCTION IF EXISTS app.slow_proc()`);
    await started?.stop();
  });

  it("reports a slow query with its SQL and the GraphQL operation that produced it", async () => {
    const response = await started.context.gql(`query SlowProbe { ${probe} { id } }`);
    expect(response.errors).toBeUndefined();

    const record = recordFor("SlowProbe");
    expect(record).toBeDefined();
    expect(record!.sql).toContain("slow_probe");
    expect(record!.operation).toEqual({ type: "query", name: "SlowProbe", fields: [probe] });
    expect(record!.role).toBe("anonymous");
    expect(record!.outcome).toBe("success");
    expect(record!.durationMs).toBeGreaterThan(THRESHOLD_MS);
    expect(record!.thresholdMs).toBe(THRESHOLD_MS);
  });

  it("reports a slow stored procedure with the mutation that called it", async () => {
    const response = await started.context.gql(`mutation SlowCall { ${procedure} }`);
    expect(response.errors).toBeUndefined();

    const record = recordFor("SlowCall");
    expect(record).toBeDefined();
    expect(record!.procedure).toContain("slow_proc");
    expect(record!.operation).toEqual({ type: "mutation", name: "SlowCall", fields: [procedure] });
    expect(record!.role).toBe("anonymous");
  });

  it("reports a slow subscription poll with the subscription that produced it", async () => {
    const client = await started.context.subscribe(`subscription SlowWatch { ${probe} { id } }`);
    try {
      await client.nextData(5_000);
    } finally {
      client.close();
    }

    const record = recordFor("SlowWatch");
    expect(record).toBeDefined();
    expect(record!.operation).toEqual({ type: "subscription", name: "SlowWatch", fields: [probe] });
    expect(record!.role).toBe("anonymous");
  });
});

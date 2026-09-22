import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { VariableDefinition } from "../../analyzeQuery/types";
import type { QuerySource, SlowQueryRecord } from "../../logging/slowQuery";
import type { Database } from "../../types/configuration";
import type { ProcedureResolver } from "../../types/db";

import { dbMSSQL, dbMySQL, dbPostgreSQL } from "../../__test/dbMocks";
import { attributeOf, installSpanSink, stringAttribute } from "../../__test/spanSink";
import { startSpan, withActiveSpan } from "../../observability/tracing";
import { setSlowQueryLog, setSlowQueryMs } from "../../logging/slowQuery";
import { callStoredProcedure, executeQuery, executeQueryJSON } from "./executor";
import { databaseAdapters } from "./function-mapping";

type EngineKey = "pg" | "mssql" | "mysql";

type AdapterMethod = "execute" | "executeJson" | "callStoredProcedure";

const stub = <M extends AdapterMethod>(
  engine: EngineKey,
  method: M,
  impl: (typeof databaseAdapters)[EngineKey][M],
) => {
  const original = databaseAdapters[engine][method];
  databaseAdapters[engine][method] = impl;
  return () => {
    databaseAdapters[engine][method] = original;
  };
};

const variableDefs: VariableDefinition[] = [{ name: "id", type: "ID", required: true }];

const cases: Array<{ engine: EngineKey; db: Database }> = [
  { engine: "pg", db: dbPostgreSQL },
  { engine: "mssql", db: dbMSSQL },
  { engine: "mysql", db: dbMySQL },
];

describe("executeQuery", () => {
  const restorers: Array<() => void> = [];
  beforeEach(() => {
    restorers.length = 0;
  });
  afterEach(() => {
    while (restorers.length) restorers.pop()?.();
  });

  for (const { engine, db } of cases) {
    it(`dispatches to the ${engine} engine and returns its rows`, async () => {
      const recorded: Array<{
        query: string;
        db: Database;
        defs: VariableDefinition[];
        values: Record<string, unknown>;
      }> = [];

      restorers.push(stub("pg", "execute", async () => [] as never));
      restorers.push(stub("mssql", "execute", async () => [] as never));
      restorers.push(stub("mysql", "execute", async () => [] as never));
      restorers.push(
        stub(engine, "execute", (async (
          query: string,
          dbArg: Database,
          defs: VariableDefinition[],
          values: Record<string, unknown>,
        ) => {
          recorded.push({ query, db: dbArg, defs, values });
          return [{ id: engine }];
        }) as (typeof databaseAdapters)[EngineKey]["execute"]),
      );

      const result = await executeQuery<{ id: string }>("select 1", db, variableDefs, { id: 7 });

      expect(result).toEqual([{ id: engine }]);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].query).toBe("select 1");
      expect(recorded[0].db).toBe(db);
      expect(recorded[0].defs).toBe(variableDefs);
      expect(recorded[0].values).toEqual({ id: 7 });
    });
  }

  it("throws on unsupported database type", async () => {
    const bogus = { ...dbPostgreSQL, type: "sqlite" } as unknown as Database;

    await expect(executeQuery("select 1", bogus, variableDefs, {})).rejects.toThrow(
      "Unsupported database type: sqlite",
    );
  });

  it("throws when db argument is undefined", async () => {
    await expect(
      executeQuery("select 1", undefined as unknown as Database, variableDefs, {}),
    ).rejects.toThrow("Unsupported database type:");
  });

  it("propagates pool errors", async () => {
    restorers.push(
      stub("pg", "execute", (async () => {
        throw new Error("boom");
      }) as (typeof databaseAdapters)[EngineKey]["execute"]),
    );

    await expect(executeQuery("select 1", dbPostgreSQL, variableDefs, {})).rejects.toThrow("boom");
  });
});

describe("executeQueryJSON", () => {
  const restorers: Array<() => void> = [];
  beforeEach(() => {
    restorers.length = 0;
  });
  afterEach(() => {
    while (restorers.length) restorers.pop()?.();
  });

  for (const { engine, db } of cases) {
    it(`dispatches to the ${engine} engine executeJson`, async () => {
      restorers.push(
        stub(engine, "executeJson", (async () => ({
          source: engine,
        })) as (typeof databaseAdapters)[EngineKey]["executeJson"]),
      );

      const result = await executeQueryJSON<{ source: string }>(
        "select json",
        db,
        variableDefs,
        {},
      );

      expect(result).toEqual({ source: engine });
    });
  }

  it("throws on unsupported database type", async () => {
    const bogus = { ...dbPostgreSQL, type: "sqlite" } as unknown as Database;

    await expect(executeQueryJSON("select 1", bogus, variableDefs, {})).rejects.toThrow(
      "Unsupported database type: sqlite",
    );
  });

  it("propagates adapter errors", async () => {
    restorers.push(
      stub("pg", "executeJson", (async () => {
        throw new Error("json-boom");
      }) as (typeof databaseAdapters)[EngineKey]["executeJson"]),
    );

    await expect(executeQueryJSON("select 1", dbPostgreSQL, variableDefs, {})).rejects.toThrow(
      "json-boom",
    );
  });
});

describe("callStoredProcedure", () => {
  const restorers: Array<() => void> = [];
  beforeEach(() => {
    restorers.length = 0;
  });
  afterEach(() => {
    while (restorers.length) restorers.pop()?.();
  });

  const buildSP = (db: Database) =>
    ({ db, name: "sp_x", schema: "dbo" }) as unknown as ProcedureResolver;

  for (const { engine, db } of cases) {
    it(`dispatches to the ${engine} engine callStoredProcedure`, async () => {
      const recorded: Array<{
        sp: ProcedureResolver;
        params: Record<string, unknown>;
      }> = [];

      restorers.push(
        stub(engine, "callStoredProcedure", (async (
          sp: ProcedureResolver,
          params: Record<string, unknown>,
        ) => {
          recorded.push({ sp, params });
          return { engine };
        }) as (typeof databaseAdapters)[EngineKey]["callStoredProcedure"]),
      );

      const sp = buildSP(db);
      const result = await callStoredProcedure(sp, { p: 1 });

      expect(result).toEqual({ engine });
      expect(recorded[0].sp).toBe(sp);
      expect(recorded[0].params).toEqual({ p: 1 });
    });
  }

  it("throws on unsupported database type", async () => {
    const bogus = { ...dbPostgreSQL, type: "sqlite" } as unknown as Database;

    await expect(callStoredProcedure(buildSP(bogus), {})).rejects.toThrow(
      "Unsupported database type: sqlite",
    );
  });

  it("defaults parameters to empty object when omitted", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    restorers.push(
      stub("pg", "callStoredProcedure", (async (
        _sp: ProcedureResolver,
        params: Record<string, unknown>,
      ) => {
        recorded.push(params);
        return undefined;
      }) as (typeof databaseAdapters)[EngineKey]["callStoredProcedure"]),
    );

    await callStoredProcedure(buildSP(dbPostgreSQL));

    expect(recorded[0]).toEqual({});
  });
});

describe("slow query log", () => {
  const restorers: Array<() => void> = [];
  const records: Array<SlowQueryRecord & { thresholdMs: number }> = [];

  const source: QuerySource = {
    operation: { type: "query", name: "RecentOrders", fields: ["orders"] },
    role: "user",
  };

  const slowly =
    <T>(value: T) =>
    async () => {
      await Bun.sleep(20);
      return value;
    };

  const failingSlowly = async () => {
    await Bun.sleep(20);
    throw new Error("canceling statement due to statement timeout");
  };

  beforeEach(() => {
    restorers.length = 0;
    records.length = 0;
    setSlowQueryLog({ emit: (record) => records.push(record) });
    setSlowQueryMs(5);
  });
  afterEach(() => {
    while (restorers.length) restorers.pop()?.();
    setSlowQueryLog(null);
    setSlowQueryMs(0);
  });

  it("reports a slow JSON query with its SQL, the operation and the role", async () => {
    restorers.push(
      stub("pg", "executeJson", slowly({}) as (typeof databaseAdapters)[EngineKey]["executeJson"]),
    );

    await executeQueryJSON(
      'SELECT "id" FROM "public"."orders"',
      dbPostgreSQL,
      variableDefs,
      { id: 7 },
      undefined,
      source,
    );

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.sql).toBe('SELECT "id" FROM "public"."orders"');
    expect(record.operation).toEqual(source.operation);
    expect(record.role).toBe("user");
    expect(record.dbType).toBe("pg");
    expect(record.dbName).toBe(dbPostgreSQL.name);
    expect(record.outcome).toBe("success");
    expect(record.durationMs).toBeGreaterThan(5);
    expect(record.thresholdMs).toBe(5);
  });

  it("reports a slow plain query", async () => {
    restorers.push(
      stub("mysql", "execute", slowly([]) as (typeof databaseAdapters)[EngineKey]["execute"]),
    );

    await executeQuery("SELECT 1", dbMySQL, variableDefs, {}, undefined, source);

    expect(records).toHaveLength(1);
    expect(records[0].sql).toBe("SELECT 1");
    expect(records[0].operation).toEqual(source.operation);
  });

  it("reports a slow stored procedure by name", async () => {
    restorers.push(
      stub(
        "mssql",
        "callStoredProcedure",
        slowly(undefined) as (typeof databaseAdapters)[EngineKey]["callStoredProcedure"],
      ),
    );

    const sp = {
      db: dbMSSQL,
      name: "sp_x",
      dottedName: "dbo.sp_x",
    } as unknown as ProcedureResolver;
    await callStoredProcedure(sp, {}, source);

    expect(records).toHaveLength(1);
    expect(records[0].procedure).toBe("dbo.sp_x");
    expect(records[0].sql).toBeUndefined();
    expect(records[0].operation).toEqual(source.operation);
  });

  it("reports a statement that failed after running past the threshold", async () => {
    restorers.push(
      stub(
        "pg",
        "executeJson",
        failingSlowly as (typeof databaseAdapters)[EngineKey]["executeJson"],
      ),
    );

    await expect(
      executeQueryJSON("SELECT pg_sleep(30)", dbPostgreSQL, variableDefs, {}, undefined, source),
    ).rejects.toThrow("statement timeout");

    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("error");
    expect(records[0].sql).toBe("SELECT pg_sleep(30)");
  });

  it("never carries the variable values", async () => {
    restorers.push(
      stub("pg", "executeJson", slowly({}) as (typeof databaseAdapters)[EngineKey]["executeJson"]),
    );

    await executeQueryJSON(
      "SELECT 1",
      dbPostgreSQL,
      variableDefs,
      { id: "ana@acme.test" },
      undefined,
      source,
    );

    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("ana@acme.test");
  });

  it("stays silent for a statement under the threshold", async () => {
    setSlowQueryMs(10_000);
    restorers.push(
      stub("pg", "executeJson", slowly({}) as (typeof databaseAdapters)[EngineKey]["executeJson"]),
    );

    await executeQueryJSON("SELECT 1", dbPostgreSQL, variableDefs, {}, undefined, source);

    expect(records).toHaveLength(0);
  });
});

describe("tracing", () => {
  const restorers: Array<() => void> = [];
  let sink: ReturnType<typeof installSpanSink>;

  const source: QuerySource = {
    operation: { type: "query", name: "RecentOrders", fields: ["orders"] },
    role: "user",
  };

  beforeEach(() => {
    restorers.length = 0;
    sink = installSpanSink();
  });

  afterEach(() => {
    sink.restore();
    while (restorers.length) restorers.pop()?.();
  });

  it("spans a statement with the engine, the database and the SQL it sent", async () => {
    restorers.push(stub("pg", "executeJson", (async () => ({})) as never));

    await executeQueryJSON("SELECT 1", dbPostgreSQL, variableDefs, {}, undefined, source);

    const [span] = await sink.spans();

    expect(span!.name).toBe("db.query");
    expect(span!.kind).toBe(3);
    expect(stringAttribute(span!, "db.system")).toBe(dbPostgreSQL.type);
    expect(stringAttribute(span!, "db.name")).toBe(dbPostgreSQL.name);
    expect(stringAttribute(span!, "db.statement")).toBe("SELECT 1");
    expect(stringAttribute(span!, "graphql.operation.name")).toBe("RecentOrders");
    expect(stringAttribute(span!, "graphql.operation.type")).toBe("query");
    expect(stringAttribute(span!, "graphoria.role")).toBe("user");
  });

  it("spans a non-JSON statement the same way", async () => {
    restorers.push(stub("mysql", "execute", (async () => []) as never));

    await executeQuery("SELECT 2", dbMySQL, variableDefs, {}, undefined, source);

    const [span] = await sink.spans();

    expect(span!.name).toBe("db.query");
    expect(stringAttribute(span!, "db.statement")).toBe("SELECT 2");
  });

  it("names a stored procedure rather than carrying a statement", async () => {
    restorers.push(stub("mssql", "callStoredProcedure", (async () => undefined) as never));

    const sp = {
      db: dbMSSQL,
      name: "sp_x",
      dottedName: "dbo.sp_x",
    } as unknown as ProcedureResolver;
    await callStoredProcedure(sp, {}, source);

    const [span] = await sink.spans();

    expect(span!.name).toBe("db.procedure");
    expect(stringAttribute(span!, "db.operation")).toBe("dbo.sp_x");
    expect(attributeOf(span!, "db.statement")).toBeUndefined();
  });

  it("marks a failed statement errored and still rethrows", async () => {
    restorers.push(
      stub("pg", "executeJson", (async () => {
        throw new Error("statement timeout");
      }) as never),
    );

    await expect(
      executeQueryJSON("SELECT 3", dbPostgreSQL, variableDefs, {}, undefined, source),
    ).rejects.toThrow("statement timeout");

    const [span] = await sink.spans();

    expect(span!.status).toEqual({ code: 2, message: "statement timeout" });
  });

  it("parents the statement on whatever span is active", async () => {
    restorers.push(stub("pg", "executeJson", (async () => ({})) as never));

    const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };
    await withActiveSpan(startSpan("operation", { parent }), () =>
      executeQueryJSON("SELECT 4", dbPostgreSQL, variableDefs, {}, undefined, source),
    );

    const spans = await sink.spans();
    const statement = spans.find((span) => span.name === "db.query")!;

    expect(statement.traceId).toBe(parent.traceId);
    expect(statement.parentSpanId).not.toBe(parent.spanId);
  });

  it("never carries the variable values", async () => {
    restorers.push(stub("pg", "executeJson", (async () => ({})) as never));

    await executeQueryJSON(
      "SELECT 5",
      dbPostgreSQL,
      variableDefs,
      { id: "ana@acme.test" },
      undefined,
      source,
    );

    expect(JSON.stringify(await sink.spans())).not.toContain("ana@acme.test");
  });

  it("records nothing while tracing is disabled", async () => {
    sink.restore();
    restorers.push(stub("pg", "executeJson", (async () => ({})) as never));

    await executeQueryJSON("SELECT 6", dbPostgreSQL, variableDefs, {}, undefined, source);

    expect(await sink.spans()).toHaveLength(0);
  });
});

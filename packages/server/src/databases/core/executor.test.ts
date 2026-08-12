import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { VariableDefinition } from "../../analyzeQuery/types";
import type { Database } from "../../types/configuration";
import type { ProcedureResolver } from "../../types/db";

import { dbMSSQL, dbMySQL, dbPostgreSQL } from "../../__test/dbMocks";
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
        defs: VariableDefinition[];
        params: Record<string, unknown>;
      }> = [];

      restorers.push(
        stub(engine, "callStoredProcedure", (async (
          sp: ProcedureResolver,
          defs: VariableDefinition[],
          params: Record<string, unknown>,
        ) => {
          recorded.push({ sp, defs, params });
          return { engine };
        }) as (typeof databaseAdapters)[EngineKey]["callStoredProcedure"]),
      );

      const sp = buildSP(db);
      const result = await callStoredProcedure(sp, variableDefs, { p: 1 });

      expect(result).toEqual({ engine });
      expect(recorded[0].sp).toBe(sp);
      expect(recorded[0].defs).toBe(variableDefs);
      expect(recorded[0].params).toEqual({ p: 1 });
    });
  }

  it("throws on unsupported database type", async () => {
    const bogus = { ...dbPostgreSQL, type: "sqlite" } as unknown as Database;

    await expect(callStoredProcedure(buildSP(bogus), variableDefs, {})).rejects.toThrow(
      "Unsupported database type: sqlite",
    );
  });

  it("defaults parameters to empty object when omitted", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    restorers.push(
      stub("pg", "callStoredProcedure", (async (
        _sp: ProcedureResolver,
        _defs: VariableDefinition[],
        params: Record<string, unknown>,
      ) => {
        recorded.push(params);
        return undefined;
      }) as (typeof databaseAdapters)[EngineKey]["callStoredProcedure"]),
    );

    await callStoredProcedure(buildSP(dbPostgreSQL), variableDefs);

    expect(recorded[0]).toEqual({});
  });
});

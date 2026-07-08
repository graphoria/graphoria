import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  AnalysisResult,
  OperationAnalysis,
  SelectionAnalysis,
} from "../../analyzeQuery/types";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { Database } from "../../types/configuration";

import { dbMSSQL, dbMySQL, dbPostgreSQL } from "../../__test/dbMocks";
import { databaseAdapters } from "./function-mapping";
import { generateSQL } from "./query-builder";

type EngineKey = "pg" | "mssql" | "mysql";

type RecordedQueryCall = {
  entities: MergedEntities;
  operation: OperationAnalysis;
  variables: Record<string, unknown>;
  forHashMethod: boolean;
};

const stubAdapter = (
  engine: EngineKey,
  impl: (...args: Parameters<(typeof databaseAdapters)[EngineKey]["query"]>) => string,
) => {
  const original = databaseAdapters[engine].query;
  databaseAdapters[engine].query = impl as typeof original;
  return () => {
    databaseAdapters[engine].query = original;
  };
};

const buildEntities = (fieldsByDb: Record<string, Database>): MergedEntities => {
  const queriesMap = Object.fromEntries(
    Object.entries(fieldsByDb).map(([fieldName, db]) => [
      fieldName,
      { db } as MergedEntities["queriesMap"][string],
    ]),
  ) as MergedEntities["queriesMap"];

  return { queriesMap } as unknown as MergedEntities;
};

const buildAnalysis = (fieldNames: string[]): AnalysisResult => {
  const fields = fieldNames.map((name) => ({ name }) as SelectionAnalysis);
  return {
    operations: [
      {
        name: null,
        operation: "query",
        fields,
      } satisfies OperationAnalysis,
    ],
    fragments: [],
  };
};

describe("generateSQL dispatcher", () => {
  const restorers: Array<() => void> = [];

  beforeEach(() => {
    restorers.length = 0;
  });

  afterEach(() => {
    while (restorers.length) {
      restorers.pop()?.();
    }
  });

  const cases: Array<{ engine: EngineKey; db: Database; tag: string }> = [
    { engine: "pg", db: dbPostgreSQL, tag: "PG_SQL" },
    { engine: "mssql", db: dbMSSQL, tag: "MSSQL_SQL" },
    { engine: "mysql", db: dbMySQL, tag: "MYSQL_SQL" },
  ];

  for (const { engine, db, tag } of cases) {
    it(`routes to the ${engine} engine query builder`, () => {
      const calls: RecordedQueryCall[] = [];
      restorers.push(
        stubAdapter(engine, (entities, operation, variables, forHashMethod) => {
          calls.push({ entities, operation, variables, forHashMethod });
          return tag;
        }),
      );

      const entities = buildEntities({ users: db });
      const result = generateSQL(entities, buildAnalysis(["users"]), { x: 1 });

      expect(result).toEqual([[db, tag]]);
      expect(calls).toHaveLength(1);
      expect(calls[0].entities).toBe(entities);
      expect(calls[0].operation.fields.map((f) => f.name)).toEqual(["users"]);
      expect(calls[0].variables).toEqual({ x: 1 });
      expect(calls[0].forHashMethod).toBe(false);
    });
  }

  it("groups fields by database name and dispatches per engine", () => {
    const pgPrimary: Database = { ...dbPostgreSQL, name: "primary" };
    const mssqlWarehouse: Database = { ...dbMSSQL, name: "warehouse" };

    const pgCalls: RecordedQueryCall[] = [];
    const mssqlCalls: RecordedQueryCall[] = [];
    restorers.push(
      stubAdapter("pg", (entities, operation, variables, forHashMethod) => {
        pgCalls.push({ entities, operation, variables, forHashMethod });
        return "PG";
      }),
    );
    restorers.push(
      stubAdapter("mssql", (entities, operation, variables, forHashMethod) => {
        mssqlCalls.push({ entities, operation, variables, forHashMethod });
        return "MSSQL";
      }),
    );

    const entities = buildEntities({
      users: pgPrimary,
      orders: mssqlWarehouse,
      profiles: pgPrimary,
    });

    const result = generateSQL(entities, buildAnalysis(["users", "orders", "profiles"]));

    expect(result).toEqual([
      [pgPrimary, "PG"],
      [mssqlWarehouse, "MSSQL"],
    ]);
    expect(pgCalls).toHaveLength(1);
    expect(mssqlCalls).toHaveLength(1);
    expect(pgCalls[0].operation.fields.map((f) => f.name)).toEqual(["users", "profiles"]);
    expect(mssqlCalls[0].operation.fields.map((f) => f.name)).toEqual(["orders"]);
  });

  it("forwards forHashMethod flag to the engine builder", () => {
    const calls: RecordedQueryCall[] = [];
    restorers.push(
      stubAdapter("pg", (entities, operation, variables, forHashMethod) => {
        calls.push({ entities, operation, variables, forHashMethod });
        return "x";
      }),
    );

    generateSQL(buildEntities({ users: dbPostgreSQL }), buildAnalysis(["users"]), { y: 2 }, true);

    expect(calls[0].forHashMethod).toBe(true);
    expect(calls[0].variables).toEqual({ y: 2 });
  });

  it("throws on unsupported database type", () => {
    const bogus = { ...dbPostgreSQL, type: "sqlite" } as unknown as Database;
    const entities = buildEntities({ users: bogus });

    expect(() => generateSQL(entities, buildAnalysis(["users"]))).toThrow(
      "Unsupported database type: sqlite",
    );
  });
});

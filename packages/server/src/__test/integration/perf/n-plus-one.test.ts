import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "../harness";
import type { DatabaseFunctions } from "../../../databases/core/function-mapping";
import type { DatabaseType } from "../../../types/configuration";

import { ENGINES, SCHEMAS, fieldName } from "../config";
import { databaseAdapters } from "../../../databases/core/function-mapping";
import { integrationEnabled, startServer } from "../harness";

/**
 * Task 5.1 of the hardening plan: determine empirically how nested
 * relationships resolve — one joined statement, one per level, or one per
 * parent row — and assert on the count of statements the database receives.
 *
 * Two independent measurements, because neither alone is enough:
 *
 * - Every statement leaving the process is captured at the adapter seam, which
 *   is the last place a query exists before the driver writes it to the socket.
 *   This runs on all three engines.
 * - On PostgreSQL `pg_stat_statements` counts the same statements from inside
 *   the server, so a statement the seam missed — one the driver issued on its
 *   own — would show up as a discrepancy.
 *
 * The last case here measures what the statement count deliberately cannot see:
 * a single statement can still do per-parent work inside the engine. It records
 * that shape rather than objecting to it.
 */

/** Extra parents, over the seeded three, so a per-parent count is unmistakable. */
const FILLER_PROJECTS = 100;
/** Children per filler parent. */
const TASKS_PER_PROJECT = 10;
const FIRST_PROJECT_ID = 1001;
const FIRST_TASK_ID = 10_001;

/**
 * Wraps the two statement-issuing adapter functions so the queries `fn` causes
 * are recorded, and puts the originals back afterwards. The adapter map is the
 * single dispatch point every engine call goes through, so nothing that reaches
 * a database escapes this.
 */
const recordStatements = async (engine: DatabaseType, fn: () => Promise<unknown>) => {
  const adapter = databaseAdapters[engine];
  const original: Pick<DatabaseFunctions, "execute" | "executeJson"> = {
    execute: adapter.execute,
    executeJson: adapter.executeJson,
  };
  const statements: string[] = [];

  // Written out twice rather than shared: the two differ in return type, and a
  // wrapper generic enough to cover both can only be expressed with a cast.
  const execute: DatabaseFunctions["execute"] = (query, db, definitions, values, timeoutMs) => {
    statements.push(query);
    return original.execute(query, db, definitions, values, timeoutMs);
  };

  const executeJson: DatabaseFunctions["executeJson"] = (
    query,
    db,
    definitions,
    values,
    timeoutMs,
  ) => {
    statements.push(query);
    return original.executeJson(query, db, definitions, values, timeoutMs);
  };

  adapter.execute = execute;
  adapter.executeJson = executeJson;

  try {
    await fn();
    return statements;
  } finally {
    adapter.execute = original.execute;
    adapter.executeJson = original.executeJson;
  }
};

const boolLiteral = (engine: DatabaseType) => (engine === "mssql" ? "0" : "false");

/** `INSERT ... VALUES` in chunks: SQL Server caps a values list at 1000 rows. */
const insertRows = async (
  sql: IntegrationContext["sql"],
  table: string,
  columns: string,
  rows: string[],
) => {
  for (let index = 0; index < rows.length; index += 500) {
    await sql(
      `INSERT INTO ${table} (${columns}) VALUES ${rows.slice(index, index + 500).join(", ")}`,
    );
  }
};

const seedFiller = async (engine: DatabaseType, sql: IntegrationContext["sql"]) => {
  const app = SCHEMAS[engine].app;
  const archived = boolLiteral(engine);
  const completed = boolLiteral(engine);

  await insertRows(
    sql,
    `${app}.projects`,
    "id, organization_id, owner_id, name, archived",
    Array.from(
      { length: FILLER_PROJECTS },
      (_, index) => `(${FIRST_PROJECT_ID + index}, 1, 1, 'filler-${index}', ${archived})`,
    ),
  );

  await insertRows(
    sql,
    `${app}.tasks`,
    "id, project_id, organization_id, title, priority, completed",
    Array.from({ length: FILLER_PROJECTS * TASKS_PER_PROJECT }, (_, index) => {
      const projectId = FIRST_PROJECT_ID + Math.floor(index / TASKS_PER_PROJECT);
      return `(${FIRST_TASK_ID + index}, ${projectId}, 1, 'filler task ${index}', 1, ${completed})`;
    }),
  );
};

describe.skipIf(!integrationEnabled)("perf · n+1 statement count", () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      let started: StartedServer;
      let gql: IntegrationContext["gql"];

      const projects = fieldName(engine, "app", "projects");
      const tasks = fieldName(engine, "app", "tasks");
      const organizations = fieldName(engine, "app", "organizations");

      /** One parent level, one child level, `limit` parents. */
      const nested = (limit: number) =>
        `query { ${projects}(limit: ${limit}, orderBy: [{ id: ASC }]) { id ${tasks}(orderBy: [{ id: ASC }]) { id } } }`;

      beforeAll(async () => {
        started = await startServer({ engine });
        gql = started.context.gql;
        await seedFiller(engine, started.context.sql);
      });

      afterAll(async () => {
        await started?.stop();
      });

      it("sends one statement whatever the parent count", async () => {
        const forTen = await recordStatements(engine, () => gql(nested(10)));
        const forHundred = await recordStatements(engine, () => gql(nested(100)));

        expect(forTen).toHaveLength(1);
        expect(forHundred).toHaveLength(1);
      });

      it("sends one statement whatever the nesting depth", async () => {
        const depthOne = await recordStatements(engine, () =>
          gql(`query { ${projects}(limit: 50, orderBy: [{ id: ASC }]) { id } }`),
        );
        const depthThree = await recordStatements(engine, () =>
          gql(
            `query { ${organizations}(orderBy: [{ id: ASC }]) { id ${projects}(orderBy: [{ id: ASC }]) { id ${tasks}(orderBy: [{ id: ASC }]) { id } } } }`,
          ),
        );

        expect(depthOne).toHaveLength(1);
        expect(depthThree).toHaveLength(1);
      });

      it("returns the rows the single statement was asked for", async () => {
        const response = await gql<{ [key: string]: { id: number; [child: string]: unknown }[] }>(
          nested(100),
        );

        expect(response.errors ?? []).toEqual([]);

        const rows = response.data![projects]!;
        expect(rows).toHaveLength(100);
        const filler = rows.find((row) => row.id === FIRST_PROJECT_ID)!;
        expect(filler[tasks] as unknown[]).toHaveLength(TASKS_PER_PROJECT);
      });
    });
  }
});

/** Shape of the nodes `EXPLAIN (ANALYZE, FORMAT JSON)` returns, as far as used here. */
type PlanNode = {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Actual Loops": number;
  Plans?: PlanNode[];
};

const subPlanLoops = (node: PlanNode): number[] => [
  ...(node["Parent Relationship"] === "SubPlan" ? [node["Actual Loops"]] : []),
  ...(node.Plans ?? []).flatMap(subPlanLoops),
];

describe.skipIf(!integrationEnabled)("perf · n+1 · postgresql plan", () => {
  let started: StartedServer;
  let gql: IntegrationContext["gql"];
  let sql: IntegrationContext["sql"];

  const projects = fieldName("pg", "app", "projects");
  const tasks = fieldName("pg", "app", "tasks");
  const organizations = fieldName("pg", "app", "organizations");

  const nested = (limit: number) =>
    `query { ${projects}(limit: ${limit}, orderBy: [{ id: ASC }]) { id ${tasks}(orderBy: [{ id: ASC }]) { id } } }`;

  beforeAll(async () => {
    started = await startServer({ engine: "pg" });
    gql = started.context.gql;
    sql = started.context.sql;
    await seedFiller("pg", sql);

    // Fails loudly rather than skipping: without the extension this file's
    // database-side half silently stops measuring anything. It needs
    // `shared_preload_libraries=pg_stat_statements`, which docker-compose.test.yml
    // passes — a stack started before that change has to be recreated.
    await sql("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  });

  afterAll(async () => {
    await started?.stop();
  });

  /** Statements the server itself recorded, counted from inside PostgreSQL. */
  const generatedCalls = async () => {
    const rows = await sql<{ calls: number }>(
      `SELECT COALESCE(SUM(calls), 0)::int AS calls FROM pg_stat_statements
       WHERE query LIKE '%json_build_object%' AND query NOT LIKE 'EXPLAIN%'`,
    );
    return rows[0]!.calls;
  };

  it("PostgreSQL received exactly one statement, and the same one for 10 parents as for 100", async () => {
    for (const limit of [10, 100]) {
      await sql("SELECT pg_stat_statements_reset()");
      await gql(nested(limit));

      expect(await generatedCalls()).toBe(1);
    }
  });

  /**
   * The statement count is deliberately blind to this: one statement can still
   * do per-parent work. It does — the child selection is a correlated subquery,
   * so PostgreSQL runs its subplan once per parent row. That is the current
   * shape, not a defect this suite objects to; changing it is a query-builder
   * redesign, and this case is what would go red if one landed.
   *
   * Neither query takes an argument: `limit` and `where` values reach the
   * driver as `$1`, and a statement carrying a parameter reference cannot be
   * handed straight back to `EXPLAIN`. Without one the parent count is the
   * default page size, so the two cases differ in how many parent rows exist,
   * not in how they are asked for.
   */
  it("resolves the child selection once per parent row inside the engine", async () => {
    const loopsFor = async (query: string) => {
      const [statement] = await recordStatements("pg", () => gql(query));

      const rows = await sql<Record<string, unknown>>(
        `EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF) ${statement}`,
      );
      const raw = rows[0]!["QUERY PLAN"];
      const plans = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];

      return subPlanLoops(plans[0]!.Plan);
    };

    // 103 projects exist; the default page size caps the parent set at 100.
    expect(
      await loopsFor(
        `query { ${projects}(orderBy: [{ id: ASC }]) { id ${tasks}(orderBy: [{ id: ASC }]) { id } } }`,
      ),
    ).toContain(100);

    // Same shape over the two seeded organizations.
    expect(
      await loopsFor(
        `query { ${organizations}(orderBy: [{ id: ASC }]) { id ${projects}(orderBy: [{ id: ASC }]) { id } } }`,
      ),
    ).toContain(2);
  });
});

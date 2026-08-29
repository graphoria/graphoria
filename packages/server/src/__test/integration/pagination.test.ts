import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { ENGINES, SCHEMAS, fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * Page bounds, asserted on the rows the engine returns rather than on the SQL
 * Graphoria generates. The unit suite proves the clause is built; only a real
 * engine proves the rows stop arriving.
 *
 * The seeded tables hold far fewer rows than the default page size, so each
 * engine gets its own filler rows here. Every other integration file re-seeds
 * on boot, so they do not leak.
 */

const DEFAULT_PAGE_SIZE = 100;
const FILLER = 120;
const FILLER_FIRST_ID = 1000;

describe.skipIf(!integrationEnabled)("integration pagination", () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      let started: StartedServer;
      let gql: IntegrationContext["gql"];
      let sql: IntegrationContext["sql"];

      const tagsField = fieldName(engine, "app", "tags");
      const projectsField = fieldName(engine, "app", "projects");
      const tasksField = fieldName(engine, "app", "tasks");
      const app = SCHEMAS[engine].app;

      beforeAll(async () => {
        started = await startServer({ engine });
        gql = started.context.gql;
        sql = started.context.sql;

        const tagRows = Array.from(
          { length: FILLER },
          (_, i) => `(${FILLER_FIRST_ID + i}, 'filler-${i}')`,
        ).join(", ");
        await sql(`INSERT INTO ${app}.tags (id, name) VALUES ${tagRows}`);

        // Hung off project 1 so the nested-list case has more children than a
        // page. organization_id must match the project's own.
        const taskRows = Array.from(
          { length: FILLER },
          (_, i) =>
            `(${FILLER_FIRST_ID + i}, 1, 1, NULL, 'filler task ${i}', NULL, 1, NULL, NULL, ${
              engine === "mssql" ? 0 : "false"
            })`,
        ).join(", ");
        await sql(
          `INSERT INTO ${app}.tasks (id, project_id, organization_id, user_id, title, notes, priority, estimate_hours, due_at, completed) VALUES ${taskRows}`,
        );
      });

      afterAll(async () => {
        await started?.stop();
      });

      const run = async <T>(query: string, variables?: Record<string, unknown>) => {
        const response = await gql<T>(query, variables);
        expect(response.errors ?? []).toEqual([]);
        return response.data as T;
      };

      it("bounds a root list that asks for no limit at the default page size", async () => {
        const data = await run<Record<string, { id: number }[]>>(`
          query { rows: ${tagsField} { id } }
        `);

        expect(data.rows).toHaveLength(DEFAULT_PAGE_SIZE);
      });

      it("still honours a caller-supplied limit under the cap", async () => {
        const data = await run<Record<string, { id: number }[]>>(`
          query { rows: ${tagsField}(limit: 7, orderBy: [{ id: ASC }]) { id } }
        `);

        expect(data.rows).toHaveLength(7);
      });

      it("pages with limit and offset over the default bound", async () => {
        const data = await run<Record<string, { rows: { id: number }[] }>>(`
          query {
            first:  ${tagsField}(limit: 3, offset: 0, orderBy: [{ id: ASC }]) { id }
            second: ${tagsField}(limit: 3, offset: 3, orderBy: [{ id: ASC }]) { id }
          }
        `);

        const asIds = (rows: unknown) => (rows as { id: number }[]).map((row) => row.id);
        expect(asIds(data.first)).toHaveLength(3);
        expect(asIds(data.second)).toHaveLength(3);
        expect(asIds(data.first)).not.toEqual(asIds(data.second));
      });

      it("rejects a limit over MAX_PAGE_SIZE rather than truncating it", async () => {
        const response = await gql(`query { rows: ${tagsField}(limit: 5000) { id } }`);

        expect(response.errors?.[0]?.message).toMatch(/5000.*1000.*MAX_PAGE_SIZE/s);
      });

      it("bounds an unbounded nested to-many list at the default page size", async () => {
        const data = await run<Record<string, { [key: string]: unknown }[]>>(`
          query {
            rows: ${projectsField}(where: { id: { eq: 1 } }) {
              id
              ${tasksField} { id }
            }
          }
        `);

        const project = data.rows[0] as Record<string, unknown>;
        expect(project[tasksField]).toHaveLength(DEFAULT_PAGE_SIZE);
      });

      // The arguments themselves are new: a nested to-many was previously
      // generated with `where` and `orderBy` only, so it could not be paged.
      it("pages a nested to-many list with limit and offset", async () => {
        const data = await run<Record<string, { [key: string]: unknown }[]>>(`
          query {
            rows: ${projectsField}(where: { id: { eq: 1 } }) {
              id
              ${tasksField}(limit: 4, offset: 2, orderBy: [{ id: ASC }]) { id }
            }
          }
        `);

        const project = data.rows[0] as Record<string, unknown>;
        expect(project[tasksField]).toHaveLength(4);
      });
    });
  }

  // REST routes never take their query from a caller — the text is the
  // operator's own configuration — so page bounds do not apply to them.
  describe("operator-authored operations are exempt", () => {
    let started: StartedServer;

    const app = SCHEMAS.pg.app;
    const tagsField = fieldName("pg", "app", "tags");

    beforeAll(async () => {
      started = await startServer({
        engine: "pg",
        config: {
          auth: {
            enabled: false,
            database: "",
            permissions: {
              anonymous: { tables: "ALL", storedProcedures: "ALL", operations: "ALL" },
            },
          },
          operations: {
            all_tags: {
              query: `query { ${tagsField} { id } }`,
              rest: { path: "/all-tags", method: "GET" },
            },
          },
        } as never,
      });

      const tagRows = Array.from(
        { length: FILLER },
        (_, i) => `(${FILLER_FIRST_ID + i}, 'filler-${i}')`,
      ).join(", ");
      await started.context.sql(`INSERT INTO ${app}.tags (id, name) VALUES ${tagRows}`);
    });

    afterAll(async () => {
      await started?.stop();
    });

    it("serves every row from an operation query that declares no limit", async () => {
      const response = await started.context.rest("/all-tags");
      const body = (await response.json()) as { data: Record<string, { id: number }[]> };

      expect(body.data[tagsField]!.length).toBeGreaterThan(DEFAULT_PAGE_SIZE);
    });
  });
});

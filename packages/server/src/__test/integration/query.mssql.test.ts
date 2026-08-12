import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * Task 1.4 of the hardening plan, SQL Server half.
 *
 * Deliberate differences from the PostgreSQL suite, all engine facts:
 *   - `json_val` is nvarchar(max) — SQL Server has no JSON column type — so it
 *     comes back as the raw string rather than an object.
 *   - @dateFormat takes a .NET format string (`yyyy-MM-dd`), not a PostgreSQL
 *     TO_CHAR template.
 */

const ENGINE = "mssql" as const;

describe.skipIf(!integrationEnabled)("query · mssql", () => {
  let started: StartedServer;
  let gql: IntegrationContext["gql"];

  beforeAll(async () => {
    started = await startServer({ engine: ENGINE });
    gql = started.context.gql;
  });

  afterAll(async () => {
    await started?.stop();
  });

  const run = async <T>(query: string, variables?: Record<string, unknown>) => {
    const response = await gql<T>(query, variables);
    expect(response.errors ?? []).toEqual([]);
    return response.data as T;
  };

  const ids = (rows: { id: number }[] | undefined) =>
    (rows ?? []).map((row) => row.id).sort((a, b) => a - b);

  describe("filter operators", () => {
    it("eq, neq, gt, gte, lt, lte", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          eq:  app_tasks(where: { priority: { eq: 5 } })  { id }
          neq: app_tasks(where: { priority: { neq: 5 } }) { id }
          gt:  app_tasks(where: { priority: { gt: 4 } })  { id }
          gte: app_tasks(where: { priority: { gte: 4 } }) { id }
          lt:  app_tasks(where: { priority: { lt: 2 } })  { id }
          lte: app_tasks(where: { priority: { lte: 2 } }) { id }
        }
      `);

      expect(ids(data.eq)).toEqual([1, 6, 7]);
      expect(ids(data.neq)).toEqual([2, 3, 4, 5, 8, 9, 10]);
      expect(ids(data.gt)).toEqual([1, 6, 7]);
      expect(ids(data.gte)).toEqual([1, 4, 6, 7, 9]);
      expect(ids(data.lt)).toEqual([3, 10]);
      expect(ids(data.lte)).toEqual([3, 5, 8, 10]);
    });

    it("in, between, is_null and not_null", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          inList:    app_tasks(where: { priority: { in: [1, 2] } })            { id }
          between:   app_tasks(where: { priority: { between: [2, 4] } })       { id }
          isNull:    app_tasks(where: { estimate_hours: { is_null: true } })   { id }
          isNotNull: app_tasks(where: { estimate_hours: { is_null: false } })  { id }
          notNull:   app_tasks(where: { estimate_hours: { not_null: true } })  { id }
          nulls:     app_tasks(where: { estimate_hours: { not_null: false } }) { id }
        }
      `);

      expect(ids(data.inList)).toEqual([3, 5, 8, 10]);
      expect(ids(data.between)).toEqual([2, 4, 5, 8, 9]);
      expect(ids(data.isNull)).toEqual([2, 5, 10]);
      expect(ids(data.isNotNull)).toEqual([1, 3, 4, 6, 7, 8, 9]);
      expect(ids(data.notNull)).toEqual([1, 3, 4, 6, 7, 8, 9]);
      expect(ids(data.nulls)).toEqual([2, 5, 10]);
    });

    // T-SQL takes no escape character unless the statement asks for one, so a
    // pattern carrying `\%` used to match nothing at all here while matching the
    // literal on PostgreSQL and MySQL.
    it("like treats %, _ and \\ in the data as literals when escaped", async () => {
      const data = await run<Record<string, { name: string }[]>>(
        `
        query Q($pct: String, $underscore: String, $backslash: String) {
          pct:        app_tags(where: { name: { like: $pct } })        { name }
          underscore: app_tags(where: { name: { like: $underscore } }) { name }
          backslash:  app_tags(where: { name: { like: $backslash } })  { name }
        }
      `,
        { pct: "100\\%", underscore: "under\\_score", backslash: "back\\\\slash" },
      );

      expect(data.pct?.map((row) => row.name)).toEqual(["100%"]);
      expect(data.underscore?.map((row) => row.name)).toEqual(["under_score"]);
      expect(data.backslash?.map((row) => row.name)).toEqual(["back\\slash"]);
    });

    it("like wildcards still match when unescaped", async () => {
      const data = await run<Record<string, { name: string }[]>>(
        `query Q($p: String) { app_tags(where: { name: { like: $p } }) { name } }`,
        { p: "%score" },
      );

      expect(data.app_tags?.map((row) => row.name)).toEqual(["under_score"]);
    });

    it("filters through a relationship", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(where: { app_projects: { name: { eq: "Cascade" } } }) { id } }
      `);

      expect(ids(data.app_tasks)).toEqual([7, 8, 9, 10]);
    });
  });

  describe("pagination and ordering", () => {
    it("limit and offset trim rows", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          limited: app_tasks(limit: 3, orderBy: [{ id: ASC }])            { id }
          offset:  app_tasks(limit: 3, offset: 2, orderBy: [{ id: ASC }]) { id }
        }
      `);

      expect(data.limited?.map((row) => row.id)).toEqual([1, 2, 3]);
      expect(data.offset?.map((row) => row.id)).toEqual([3, 4, 5]);
    });

    // OFFSET/FETCH is only legal after an ORDER BY in T-SQL, and the builder used
    // to answer that by dropping the limit and returning the whole table.
    it("honours a limit given without an order", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(limit: 3) { id } }
      `);

      expect(data.app_tasks).toHaveLength(3);
    });

    it("ASC and DESC", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          asc:  app_tasks(orderBy: [{ id: ASC }])  { id }
          desc: app_tasks(orderBy: [{ id: DESC }]) { id }
        }
      `);

      expect(data.asc?.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(data.desc?.map((row) => row.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it("synthesises every NULLS FIRST / NULLS LAST variant", async () => {
      const data = await run<Record<string, { estimate_hours: number | null }[]>>(`
        query {
          ascFirst:  app_tasks(orderBy: [{ estimate_hours: ASC_NULLS_FIRST }])  { estimate_hours }
          ascLast:   app_tasks(orderBy: [{ estimate_hours: ASC_NULLS_LAST }])   { estimate_hours }
          descFirst: app_tasks(orderBy: [{ estimate_hours: DESC_NULLS_FIRST }]) { estimate_hours }
          descLast:  app_tasks(orderBy: [{ estimate_hours: DESC_NULLS_LAST }])  { estimate_hours }
        }
      `);

      const nullFlags = (rows: { estimate_hours: number | null }[] | undefined) =>
        (rows ?? []).map((row) => row.estimate_hours === null);
      const values = (rows: { estimate_hours: number | null }[] | undefined) =>
        (rows ?? []).map((row) => row.estimate_hours).filter((value) => value !== null);

      expect(nullFlags(data.ascFirst).slice(0, 3)).toEqual([true, true, true]);
      expect(nullFlags(data.ascLast).slice(-3)).toEqual([true, true, true]);
      expect(nullFlags(data.descFirst).slice(0, 3)).toEqual([true, true, true]);
      expect(nullFlags(data.descLast).slice(-3)).toEqual([true, true, true]);

      expect(values(data.ascFirst)).toEqual([1.25, 2, 3, 4.5, 6, 8, 12]);
      expect(values(data.descLast)).toEqual([12, 8, 6, 4.5, 3, 2, 1.25]);
    });
  });

  describe("relationships", () => {
    it("traverses forward two levels", async () => {
      const data = await run<{
        app_tasks_single: { app_projects: { name: string; app_organizations: { slug: string } } };
      }>(`
        query {
          app_tasks_single(where: { id: { eq: 9 } }) {
            app_projects { name app_organizations { slug } }
          }
        }
      `);

      expect(data.app_tasks_single.app_projects.name).toBe("Cascade");
      expect(data.app_tasks_single.app_projects.app_organizations.slug).toBe("umbrella");
    });

    it("traverses in reverse and resolves the self-referential FK", async () => {
      const data = await run<{
        app_users_single: {
          app_users_ref: { display_name: string } | null;
          app_users_list: { id: number }[];
        };
      }>(`
        query {
          app_users_single(where: { id: { eq: 1 } }) {
            app_users_ref { display_name }
            app_users_list(orderBy: [{ id: ASC }]) { id }
          }
        }
      `);

      expect(data.app_users_single.app_users_ref).toBeNull();
      expect(data.app_users_single.app_users_list.map((row) => row.id)).toEqual([2, 3]);
    });

    it("serves a view", async () => {
      const data = await run<{ app_open_tasks: { id: number }[] }>(`
        query { app_open_tasks { id } }
      `);

      expect(ids(data.app_open_tasks)).toEqual([1, 2, 4, 5, 7, 8, 9]);
    });
  });

  describe("aggregates", () => {
    // SQL Server's AVG over an integer column is integer division, so avg came
    // back as 3 where PostgreSQL and MySQL both return 3.5.
    it("groups with count, min, max, sum and a fractional avg", async () => {
      const data = await run<{
        app_tasks_aggregate: {
          key: { project_id: number };
          count: number;
          min: { priority: number };
          max: { priority: number };
          sum: { priority: number };
          avg: { priority: number };
        }[];
      }>(`
        query {
          app_tasks_aggregate(groupBy: [project_id]) {
            key { project_id }
            count
            min { priority }
            max { priority }
            sum { priority }
            avg { priority }
          }
        }
      `);

      const byProject = Object.fromEntries(
        data.app_tasks_aggregate.map((group) => [group.key.project_id, group]),
      );

      expect(byProject[1]?.count).toBe(4);
      expect(byProject[1]?.sum.priority).toBe(13);
      expect(byProject[1]?.min.priority).toBe(1);
      expect(byProject[1]?.max.priority).toBe(5);
      expect(Number(byProject[2]?.avg.priority)).toBeCloseTo(3.5, 5);
      expect(Number(byProject[1]?.avg.priority)).toBeCloseTo(3.25, 5);
    });
  });

  describe("directives", () => {
    it("applies every data-transform directive", async () => {
      const data = await run<Record<string, Record<string, unknown>>>(`
        query {
          user: app_users_single(where: { id: { eq: 1 } }) {
            upper:     display_name @uppercase
            lower:     display_name @lowercase
            truncated: display_name @truncate(length: 3)
            sub:       display_name @substring(start: 5, length: 5)
            replaced:  display_name @replace(find: "Ana", replaceWith: "Bea")
            prefixed:  display_name @concat(with: "X-", position: "before")
            padded:    display_name @pad(length: 12, char: "*", side: "left")
            rpadded:   display_name @pad(length: 12, char: "*", side: "right")
            formatted: created_at @dateFormat(format: "yyyy-MM-dd")
          }
          task: app_tasks_single(where: { id: { eq: 1 } }) {
            ceiled:   estimate_hours @ceil
            floored:  estimate_hours @floor
            absolute: estimate_hours @abs
            doubled:  estimate_hours @multiply(by: 2)
          }
          nullable: app_tasks_single(where: { id: { eq: 2 } }) {
            notes @default(value: "none")
          }
        }
      `);

      expect(data.user).toEqual({
        upper: "ANA COSTA",
        lower: "ana costa",
        truncated: "Ana",
        sub: "Costa",
        replaced: "Bea Costa",
        prefixed: "X-Ana Costa",
        padded: "***Ana Costa",
        rpadded: "Ana Costa***",
        formatted: "2026-01-02",
      });

      expect(data.task).toEqual({
        ceiled: 5,
        floored: 4,
        absolute: 4.5,
        doubled: 9,
      });

      expect(data.nullable).toEqual({ notes: "none" });
    });

    it("@when includes a field only when its variables are truthy", async () => {
      const query = `query Q($show: Boolean!) {
        app_users_single(where: { id: { eq: 1 } }) { id email @when(and: [$show]) }
      }`;

      const included = await run<{ app_users_single: Record<string, unknown> }>(query, {
        show: true,
      });
      const excluded = await run<{ app_users_single: Record<string, unknown> }>(query, {
        show: false,
      });

      expect(included.app_users_single).toEqual({ id: 1, email: "ana@acme.test" });
      expect(excluded.app_users_single).toEqual({ id: 1 });
    });
  });

  describe("column types", () => {
    it("reads every seeded type family back", async () => {
      const data = await run<{ catalog_type_showcase: Record<string, unknown>[] }>(`
        query {
          catalog_type_showcase(orderBy: [{ id: ASC }]) {
            id small_int big_int decimal_val float_val char_val varchar_val text_val
            bool_val date_val ts_val uuid_val json_val
          }
        }
      `);

      const [populated, empty] = data.catalog_type_showcase;

      expect(populated).toMatchObject({
        id: 1,
        small_int: 32000,
        big_int: 9007199254740991,
        decimal_val: 123.456,
        float_val: 1.5,
        char_val: "abcde",
        varchar_val: "varchar value",
        text_val: "text value",
        bool_val: true,
        date_val: "2026-05-01",
      });

      expect(String(populated?.["ts_val"])).toStartWith("2026-05-01T10:30:00");
      expect(String(populated?.["uuid_val"]).toLowerCase()).toBe(
        "11111111-2222-3333-4444-555555555555",
      );
      // nvarchar(max), not a JSON column: the raw text comes back.
      expect(String(populated?.["json_val"])).toContain('"k"');

      expect(Object.values(empty ?? {}).filter((value) => value === null)).toHaveLength(12);
    });

    it("accepts a fractional filter on a decimal column", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_projects(where: { budget: { gt: 10000.25 } }) { id } }
      `);

      expect(ids(data.app_projects)).toEqual([1]);
    });

    it("serves reserved words and mixed-case identifiers", async () => {
      const data = await run<{
        catalog_order: { id: number; user: string; select: number }[];
        catalog_MixedCase: { Id: number; MixedColumn: string }[];
      }>(`
        query {
          catalog_order(orderBy: [{ id: ASC }]) { id user select }
          catalog_MixedCase(orderBy: [{ Id: ASC }]) { Id MixedColumn }
        }
      `);

      expect(data.catalog_order).toEqual([
        { id: 1, user: "ana", select: 10 },
        { id: 2, user: "brian", select: 20 },
      ]);
      expect(data.catalog_MixedCase.map((row) => row.MixedColumn)).toEqual([
        "mixed one",
        "mixed two",
      ]);
    });
  });
});

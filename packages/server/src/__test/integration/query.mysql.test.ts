import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * Task 1.4 of the hardening plan, MySQL half. Same ground as query.pg.test.ts,
 * against the engine that until now could not run a single query carrying a
 * bound value: the shared builders emit `$n` and Bun's MySQL adapter binds `?`.
 *
 * Deliberate differences from the PostgreSQL suite, all engine facts rather than
 * omissions:
 *   - MySQL reports BOOLEAN columns as `tinyint`, so `completed` is a GraphQL
 *     Int carrying 0/1 rather than a Boolean.
 *   - @dateFormat is unsupported on MySQL by design and raises.
 *   - The catalog has no array column: `pg_only_types` is PostgreSQL-only.
 */

const ENGINE = "mysql" as const;
const APP = "graphoria_app";
const CATALOG = "graphoria_catalog";

describe.skipIf(!integrationEnabled)("query · mysql", () => {
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
    it("binds values instead of emitting a $n identifier", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          eq:  ${APP}_tasks(where: { priority: { eq: 5 } })  { id }
          neq: ${APP}_tasks(where: { priority: { neq: 5 } }) { id }
          gt:  ${APP}_tasks(where: { priority: { gt: 4 } })  { id }
          gte: ${APP}_tasks(where: { priority: { gte: 4 } }) { id }
          lt:  ${APP}_tasks(where: { priority: { lt: 2 } })  { id }
          lte: ${APP}_tasks(where: { priority: { lte: 2 } }) { id }
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
          inList:    ${APP}_tasks(where: { priority: { in: [1, 2] } })            { id }
          between:   ${APP}_tasks(where: { priority: { between: [2, 4] } })       { id }
          isNull:    ${APP}_tasks(where: { estimate_hours: { is_null: true } })   { id }
          isNotNull: ${APP}_tasks(where: { estimate_hours: { is_null: false } })  { id }
          notNull:   ${APP}_tasks(where: { estimate_hours: { not_null: true } })  { id }
          nulls:     ${APP}_tasks(where: { estimate_hours: { not_null: false } }) { id }
        }
      `);

      expect(ids(data.inList)).toEqual([3, 5, 8, 10]);
      expect(ids(data.between)).toEqual([2, 4, 5, 8, 9]);
      expect(ids(data.isNull)).toEqual([2, 5, 10]);
      expect(ids(data.isNotNull)).toEqual([1, 3, 4, 6, 7, 8, 9]);
      expect(ids(data.notNull)).toEqual([1, 3, 4, 6, 7, 8, 9]);
      expect(ids(data.nulls)).toEqual([2, 5, 10]);
    });

    it("like treats %, _ and \\ in the data as literals when escaped", async () => {
      const data = await run<Record<string, { name: string }[]>>(
        `
        query Q($pct: String, $underscore: String, $backslash: String) {
          pct:        ${APP}_tags(where: { name: { like: $pct } })        { name }
          underscore: ${APP}_tags(where: { name: { like: $underscore } }) { name }
          backslash:  ${APP}_tags(where: { name: { like: $backslash } })  { name }
        }
      `,
        { pct: "100\\%", underscore: "under\\_score", backslash: "back\\\\slash" },
      );

      expect(data.pct?.map((row) => row.name)).toEqual(["100%"]);
      expect(data.underscore?.map((row) => row.name)).toEqual(["under_score"]);
      expect(data.backslash?.map((row) => row.name)).toEqual(["back\\slash"]);
    });

    it("filters through a relationship", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { ${APP}_tasks(where: { ${APP}_projects: { name: { eq: "Cascade" } } }) { id } }
      `);

      expect(ids(data[`${APP}_tasks`])).toEqual([7, 8, 9, 10]);
    });
  });

  describe("pagination and ordering", () => {
    it("limit and offset trim rows, not the aggregate", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          limited: ${APP}_tasks(limit: 3, orderBy: [{ id: ASC }])             { id }
          offset:  ${APP}_tasks(limit: 3, offset: 2, orderBy: [{ id: ASC }]) { id }
        }
      `);

      expect(data.limited?.map((row) => row.id)).toEqual([1, 2, 3]);
      expect(data.offset?.map((row) => row.id)).toEqual([3, 4, 5]);
    });

    it("orders an unpaginated array", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          asc:  ${APP}_tasks(orderBy: [{ id: ASC }])  { id }
          desc: ${APP}_tasks(orderBy: [{ id: DESC }]) { id }
        }
      `);

      expect(data.asc?.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(data.desc?.map((row) => row.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it("synthesises every NULLS FIRST / NULLS LAST variant", async () => {
      const data = await run<Record<string, { estimate_hours: number | null }[]>>(`
        query {
          ascFirst:  ${APP}_tasks(orderBy: [{ estimate_hours: ASC_NULLS_FIRST }])  { estimate_hours }
          ascLast:   ${APP}_tasks(orderBy: [{ estimate_hours: ASC_NULLS_LAST }])   { estimate_hours }
          descFirst: ${APP}_tasks(orderBy: [{ estimate_hours: DESC_NULLS_FIRST }]) { estimate_hours }
          descLast:  ${APP}_tasks(orderBy: [{ estimate_hours: DESC_NULLS_LAST }])  { estimate_hours }
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

    it("combines a where clause with an order, which used to be a syntax error", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { ${APP}_tasks(where: { priority: { gte: 4 } }, orderBy: [{ id: DESC }]) { id } }
      `);

      expect(data[`${APP}_tasks`]?.map((row) => row.id)).toEqual([9, 7, 6, 4, 1]);
    });
  });

  describe("relationships", () => {
    it("traverses forward two levels", async () => {
      const data = await run<Record<string, Record<string, Record<string, unknown>>>>(`
        query {
          ${APP}_tasks_single(where: { id: { eq: 9 } }) {
            ${APP}_projects { name ${APP}_organizations { slug } }
          }
        }
      `);

      const project = data[`${APP}_tasks_single`]?.[`${APP}_projects`] as {
        name: string;
        [key: string]: unknown;
      };

      expect(project.name).toBe("Cascade");
      expect((project[`${APP}_organizations`] as { slug: string }).slug).toBe("umbrella");
    });

    it("traverses in reverse and resolves the self-referential FK", async () => {
      const data = await run<Record<string, Record<string, unknown>>>(`
        query {
          ${APP}_users_single(where: { id: { eq: 1 } }) {
            ${APP}_users_ref { display_name }
            ${APP}_users_list(orderBy: [{ id: ASC }]) { id }
          }
        }
      `);

      const user = data[`${APP}_users_single`]!;
      expect(user[`${APP}_users_ref`]).toBeNull();
      expect((user[`${APP}_users_list`] as { id: number }[]).map((row) => row.id)).toEqual([2, 3]);
    });

    // A nested array is correlated to its parent, so its ORDER BY has to live in
    // a LATERAL derived table; without one the order was silently ignored.
    it("orders a nested array", async () => {
      const data = await run<Record<string, Record<string, unknown>[]>>(`
        query {
          ${APP}_organizations(where: { id: { eq: 1 } }) {
            id
            ${APP}_projects(orderBy: [{ id: DESC }]) { id }
          }
        }
      `);

      const organization = data[`${APP}_organizations`]![0]!;
      expect((organization[`${APP}_projects`] as { id: number }[]).map((row) => row.id)).toEqual([
        2, 1,
      ]);
    });

    it("serves a view", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { ${APP}_open_tasks { id } }
      `);

      expect(ids(data[`${APP}_open_tasks`])).toEqual([1, 2, 4, 5, 7, 8, 9]);
    });
  });

  describe("aggregates", () => {
    it("groups with count, min, max, sum and avg", async () => {
      const data = await run<
        Record<
          string,
          {
            key: { project_id: number };
            count: number;
            min: { priority: number };
            max: { priority: number };
            sum: { priority: number };
            avg: { priority: number };
          }[]
        >
      >(`
        query {
          ${APP}_tasks_aggregate(groupBy: [project_id]) {
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
        data[`${APP}_tasks_aggregate`]!.map((group) => [group.key.project_id, group]),
      );

      expect(byProject[1]?.count).toBe(4);
      expect(byProject[1]?.sum.priority).toBe(13);
      expect(byProject[1]?.min.priority).toBe(1);
      expect(byProject[1]?.max.priority).toBe(5);
      expect(Number(byProject[2]?.avg.priority)).toBeCloseTo(3.5, 5);
    });
  });

  describe("directives", () => {
    it("applies the transform directives MySQL supports", async () => {
      const data = await run<Record<string, Record<string, unknown>>>(`
        query {
          user: ${APP}_users_single(where: { id: { eq: 1 } }) {
            upper:     display_name @uppercase
            lower:     display_name @lowercase
            truncated: display_name @truncate(length: 3)
            sub:       display_name @substring(start: 5, length: 5)
            replaced:  display_name @replace(find: "Ana", replaceWith: "Bea")
            prefixed:  display_name @concat(with: "X-", position: "before")
            padded:    display_name @pad(length: 12, char: "*", side: "left")
            rpadded:   display_name @pad(length: 12, char: "*", side: "right")
            trimmed:   display_name @pad(length: 12, char: " ", side: "left") @trim
          }
          task: ${APP}_tasks_single(where: { id: { eq: 1 } }) {
            ceiled:   estimate_hours @ceil
            floored:  estimate_hours @floor
            absolute: estimate_hours @abs
            doubled:  estimate_hours @multiply(by: 2)
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
        trimmed: "Ana Costa",
      });

      expect(data.task).toEqual({
        ceiled: 5,
        floored: 4,
        absolute: 4.5,
        doubled: 9,
      });
    });

    it("refuses @dateFormat with an actionable error", async () => {
      const response = await gql(`
        query {
          ${APP}_users_single(where: { id: { eq: 1 } }) {
            created_at @dateFormat(format: "%Y-%m-%d")
          }
        }
      `);

      expect(response.errors?.[0]?.message).toContain("@dateFormat is not supported on MySQL");
    });

    it("@when includes a field only when its variables are truthy", async () => {
      const query = `query Q($show: Boolean!) {
        ${APP}_users_single(where: { id: { eq: 1 } }) { id email @when(and: [$show]) }
      }`;

      const included = await run<Record<string, Record<string, unknown>>>(query, { show: true });
      const excluded = await run<Record<string, Record<string, unknown>>>(query, { show: false });

      expect(included[`${APP}_users_single`]).toEqual({ id: 1, email: "ana@acme.test" });
      expect(excluded[`${APP}_users_single`]).toEqual({ id: 1 });
    });
  });

  describe("column types", () => {
    it("reads every seeded type family back", async () => {
      const data = await run<Record<string, Record<string, unknown>[]>>(`
        query {
          ${CATALOG}_type_showcase(orderBy: [{ id: ASC }]) {
            id small_int big_int decimal_val float_val char_val varchar_val text_val
            bool_val date_val ts_val json_val uuid_val
          }
        }
      `);

      const [populated, empty] = data[`${CATALOG}_type_showcase`]!;

      expect(populated).toMatchObject({
        id: 1,
        small_int: 32000,
        big_int: 9007199254740991,
        decimal_val: 123.456,
        float_val: 1.5,
        char_val: "abcde",
        varchar_val: "varchar value",
        text_val: "text value",
        date_val: "2026-05-01",
        uuid_val: "11111111-2222-3333-4444-555555555555",
      });

      // MySQL has no native boolean: BOOLEAN is tinyint(1) and introspects as
      // `tinyint`, so the column is a GraphQL Int carrying 1/0.
      expect(populated?.["bool_val"]).toBe(1);
      expect(String(populated?.["ts_val"])).toStartWith("2026-05-01 10:30:00");
      expect(populated?.["json_val"]).toEqual({ k: "v" });

      expect(Object.values(empty ?? {}).filter((value) => value === null)).toHaveLength(12);
    });

    it("serves reserved words and mixed-case identifiers", async () => {
      const data = await run<Record<string, Record<string, unknown>[]>>(`
        query {
          ${CATALOG}_order(orderBy: [{ id: ASC }]) { id user select }
          ${CATALOG}_MixedCase(orderBy: [{ Id: ASC }]) { Id MixedColumn }
        }
      `);

      expect(data[`${CATALOG}_order`]).toEqual([
        { id: 1, user: "ana", select: 10 },
        { id: 2, user: "brian", select: 20 },
      ]);
      expect(data[`${CATALOG}_MixedCase`]?.map((row) => row["MixedColumn"])).toEqual([
        "mixed one",
        "mixed two",
      ]);
    });
  });
});

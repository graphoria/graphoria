import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { virtualColumnExpression, virtualColumnFunction } from "../../config/types/virtual-columns";
import { UNSUPPORTED_IDENTIFIER_TABLES } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * Task 1.4 of the hardening plan, PostgreSQL half: assert on the rows the
 * engine actually returns, not on the SQL string Graphoria generates. The
 * string assertions in databases/engines/postgresql/query/index.test.ts pass
 * against queries that are wrong at runtime — see the `it.failing` cases below
 * and the findings section of HARDENING_PROGRESS.md.
 *
 * One server for the whole file: booting costs a full introspection round-trip.
 */

const ENGINE = "pg" as const;

describe.skipIf(!integrationEnabled)("query · pg", () => {
  let started: StartedServer;
  let gql: IntegrationContext["gql"];
  let sql: IntegrationContext["sql"];

  beforeAll(async () => {
    started = await startServer({ engine: ENGINE });
    gql = started.context.gql;
    sql = started.context.sql;
  });

  afterAll(async () => {
    await started?.stop();
  });

  /** Runs `query` and fails with the GraphQL error rather than on a null read. */
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

    it("in, on both a numeric and a string column", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          numeric: app_tasks(where: { priority: { in: [1, 2] } }) { id }
          text: app_users(where: { email: { in: ["ana@acme.test", "dan@umbrella.test"] } }) { id }
        }
      `);

      expect(ids(data.numeric)).toEqual([3, 5, 8, 10]);
      expect(ids(data.text)).toEqual([1, 4]);
    });

    it("is_null", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(where: { estimate_hours: { is_null: true } }) { id } }
      `);

      expect(ids(data.app_tasks)).toEqual([2, 5, 10]);
    });

    it("not_null", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(where: { estimate_hours: { not_null: true } }) { id } }
      `);

      expect(ids(data.app_tasks)).toEqual([1, 3, 4, 6, 7, 8, 9]);
    });

    it("between", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(where: { priority: { between: [2, 4] } }) { id } }
      `);

      expect(ids(data.app_tasks)).toEqual([2, 4, 5, 8, 9]);
    });

    it("like treats %, _ and \\ in the data as literals when escaped", async () => {
      const data = await run<Record<string, { id: number; name: string }[]>>(
        `
        query Q($pct: String, $underscore: String, $backslash: String) {
          pct:        app_tags(where: { name: { like: $pct } })        { id name }
          underscore: app_tags(where: { name: { like: $underscore } }) { id name }
          backslash:  app_tags(where: { name: { like: $backslash } })  { id name }
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
        query {
          app_tasks(where: { app_projects: { name: { eq: "Cascade" } } }) { id }
        }
      `);

      expect(ids(data.app_tasks)).toEqual([7, 8, 9, 10]);
    });
  });

  describe("pagination", () => {
    // F3: the PostgreSQL builder appends `LIMIT n OFFSET m` outside the
    // `json_agg(...)` that collapses the rows into one JSON array, so the limit
    // applies to the single aggregate row. `limit` alone is a no-op and any
    // non-zero `offset` skips the only row, returning [].
    it.failing("limit caps the row count", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(limit: 3, orderBy: [{ id: ASC }]) { id } }
      `);

      expect(data.app_tasks?.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it.failing("offset skips rows", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { app_tasks(limit: 3, offset: 2, orderBy: [{ id: ASC }]) { id } }
      `);

      expect(data.app_tasks?.map((row) => row.id)).toEqual([3, 4, 5]);
    });
  });

  describe("ordering", () => {
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

    it("every NULLS FIRST / NULLS LAST variant", async () => {
      const data = await run<Record<string, { id: number; estimate_hours: number | null }[]>>(`
        query {
          ascFirst:  app_tasks(orderBy: [{ estimate_hours: ASC_NULLS_FIRST }])  { id estimate_hours }
          ascLast:   app_tasks(orderBy: [{ estimate_hours: ASC_NULLS_LAST }])   { id estimate_hours }
          descFirst: app_tasks(orderBy: [{ estimate_hours: DESC_NULLS_FIRST }]) { id estimate_hours }
          descLast:  app_tasks(orderBy: [{ estimate_hours: DESC_NULLS_LAST }])  { id estimate_hours }
        }
      `);

      const nullPositions = (rows: { estimate_hours: number | null }[] | undefined) =>
        (rows ?? []).map((row) => row.estimate_hours === null);

      expect(nullPositions(data.ascFirst).slice(0, 3)).toEqual([true, true, true]);
      expect(nullPositions(data.ascLast).slice(-3)).toEqual([true, true, true]);
      expect(nullPositions(data.descFirst).slice(0, 3)).toEqual([true, true, true]);
      expect(nullPositions(data.descLast).slice(-3)).toEqual([true, true, true]);

      const values = (rows: { estimate_hours: number | null }[] | undefined) =>
        (rows ?? []).map((row) => row.estimate_hours).filter((value) => value !== null);

      expect(values(data.ascFirst)).toEqual([1.25, 2, 3, 4.5, 6, 8, 12]);
      expect(values(data.ascLast)).toEqual([1.25, 2, 3, 4.5, 6, 8, 12]);
      expect(values(data.descFirst)).toEqual([12, 8, 6, 4.5, 3, 2, 1.25]);
      expect(values(data.descLast)).toEqual([12, 8, 6, 4.5, 3, 2, 1.25]);
    });

    it("orders by a second key when the first ties", async () => {
      const data = await run<Record<string, { id: number; priority: number }[]>>(`
        query { app_tasks(orderBy: [{ priority: ASC }, { id: DESC }]) { id priority } }
      `);

      expect(data.app_tasks?.slice(0, 2).map((row) => row.id)).toEqual([10, 3]);
    });
  });

  describe("relationships", () => {
    it("traverses forward two levels", async () => {
      const data = await run<{
        app_tasks_single: {
          id: number;
          app_projects: { name: string; app_organizations: { slug: string } };
        };
      }>(`
        query {
          app_tasks_single(where: { id: { eq: 9 } }) {
            id
            app_projects { name app_organizations { slug } }
          }
        }
      `);

      expect(data.app_tasks_single.app_projects.name).toBe("Cascade");
      expect(data.app_tasks_single.app_projects.app_organizations.slug).toBe("umbrella");
    });

    it("traverses in reverse two levels", async () => {
      const data = await run<{
        app_organizations: {
          id: number;
          app_projects: { id: number; app_tasks: { id: number }[] }[];
        }[];
      }>(`
        query {
          app_organizations(orderBy: [{ id: ASC }]) {
            id
            app_projects(orderBy: [{ id: ASC }]) { id app_tasks(orderBy: [{ id: ASC }]) { id } }
          }
        }
      `);

      const acme = data.app_organizations.find((row) => row.id === 1);
      expect(acme?.app_projects.map((project) => project.id)).toEqual([1, 2]);
      expect(
        acme?.app_projects.flatMap((project) => project.app_tasks.map((task) => task.id)),
      ).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("resolves the self-referential FK in both directions", async () => {
      const data = await run<{
        app_users_single: {
          id: number;
          app_users_ref: { display_name: string } | null;
          app_users_list: { id: number }[];
        };
      }>(`
        query {
          app_users_single(where: { id: { eq: 1 } }) {
            id
            app_users_ref { display_name }
            app_users_list(orderBy: [{ id: ASC }]) { id }
          }
        }
      `);

      expect(data.app_users_single.app_users_ref).toBeNull();
      expect(data.app_users_single.app_users_list.map((row) => row.id)).toEqual([2, 3]);
    });

    it("resolves a many-to-many through its join table", async () => {
      const data = await run<{
        app_tags_single: { name: string; app_task_tags: { app_tasks: { title: string } }[] };
      }>(`
        query {
          app_tags_single(where: { id: { eq: 1 } }) {
            name
            app_task_tags { app_tasks { title } }
          }
        }
      `);

      expect(data.app_tags_single.app_task_tags.map((row) => row.app_tasks.title).sort()).toEqual([
        "Draft spec",
        "Review spec",
        "Umbrella kickoff",
      ]);
    });

    it("serves a view like a table", async () => {
      const data = await run<{ app_open_tasks: { id: number }[] }>(`
        query { app_open_tasks { id } }
      `);

      expect(ids(data.app_open_tasks)).toEqual([1, 2, 4, 5, 7, 8, 9]);
    });
  });

  describe("aggregates", () => {
    it("groups with count, min, max, sum and avg", async () => {
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
      expect(byProject[2]?.count).toBe(2);
      expect(byProject[3]?.count).toBe(4);
      expect(Number(byProject[2]?.avg.priority)).toBeCloseTo(3.5, 5);
    });

    it("respects a where clause and returns the grouped rows under items", async () => {
      const data = await run<{
        app_tasks_aggregate: {
          key: { project_id: number };
          count: number;
          items: { id: number }[];
        }[];
      }>(`
        query {
          app_tasks_aggregate(where: { completed: { eq: true } }, groupBy: [project_id]) {
            key { project_id }
            count
            items { id }
          }
        }
      `);

      const groups = Object.fromEntries(
        data.app_tasks_aggregate.map((group) => [group.key.project_id, group]),
      );

      expect(groups[1]?.count).toBe(1);
      expect(ids(groups[1]?.items)).toEqual([3]);
      expect(groups[2]?.count).toBe(1);
      expect(ids(groups[3]?.items)).toEqual([10]);
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
            padded:    display_name @pad(length: 12, char: "*", side: "left")
            rpadded:   display_name @pad(length: 12, char: "*", side: "right")
            trimmed:   display_name @pad(length: 12, char: " ", side: "left") @trim
            ltrimmed:  display_name @pad(length: 12, char: " ", side: "left") @ltrim
            rtrimmed:  display_name @pad(length: 12, char: " ", side: "right") @rtrim
            formatted: created_at @dateFormat(format: "YYYY-MM-DD")
          }
          task: app_tasks_single(where: { id: { eq: 1 } }) {
            rounded:  estimate_hours @round(decimals: 0)
            ceiled:   estimate_hours @ceil
            floored:  estimate_hours @floor
            absolute: estimate_hours @abs
            doubled:  estimate_hours @multiply(by: 2)
            halved:   estimate_hours @divide(by: 2)
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
        padded: "***Ana Costa",
        rpadded: "Ana Costa***",
        trimmed: "Ana Costa",
        ltrimmed: "Ana Costa",
        rtrimmed: "Ana Costa",
        formatted: "2026-01-02",
      });

      expect(data.task).toEqual({
        rounded: 5,
        ceiled: 5,
        floored: 4,
        absolute: 4.5,
        doubled: 9,
        halved: 2.25,
      });

      expect(data.nullable).toEqual({ notes: "none" });
    });

    // F5: @concat parameterises its `with` argument, and PostgreSQL cannot
    // infer a type for a bare placeholder inside CONCAT() — the query dies with
    // `could not determine data type of parameter $n`. Every other directive
    // interpolates its arguments as literals and works.
    it.failing("@concat prepends and appends", async () => {
      const data = await run<{ app_users_single: { prefixed: string; suffixed: string } }>(`
        query {
          app_users_single(where: { id: { eq: 1 } }) {
            prefixed: display_name @concat(with: "X-", position: "before")
            suffixed: display_name @concat(with: "-X")
          }
        }
      `);

      expect(data.app_users_single).toEqual({
        prefixed: "X-Ana Costa",
        suffixed: "Ana Costa-X",
      });
    });

    it("chains directives left to right", async () => {
      const data = await run<{ app_users_single: { display_name: string } }>(`
        query {
          app_users_single(where: { id: { eq: 1 } }) {
            display_name @uppercase @truncate(length: 3)
          }
        }
      `);

      expect(data.app_users_single.display_name).toBe("ANA");
    });

    it("@when includes a field only when its variables are truthy", async () => {
      const included = await run<{ app_users_single: Record<string, unknown> }>(
        `query Q($show: Boolean!) {
          app_users_single(where: { id: { eq: 1 } }) { id email @when(and: [$show]) }
        }`,
        { show: true },
      );

      const excluded = await run<{ app_users_single: Record<string, unknown> }>(
        `query Q($show: Boolean!) {
          app_users_single(where: { id: { eq: 1 } }) { id email @when(and: [$show]) }
        }`,
        { show: false },
      );

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
            bool_val date_val ts_val tstz_val json_val uuid_val bytes_val
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
        uuid_val: "11111111-2222-3333-4444-555555555555",
      });

      expect(String(populated?.["ts_val"])).toStartWith("2026-05-01T10:30:00");
      expect(String(populated?.["tstz_val"])).toStartWith("2026-05-01T10:30:00");
      expect(populated?.["json_val"]).toEqual({ k: "v" });
      expect(String(populated?.["bytes_val"])).toContain("0102");

      expect(Object.values(empty ?? {}).filter((value) => value === null)).toHaveLength(14);
    });

    it("round-trips a written row through the read path", async () => {
      await sql(`
        INSERT INTO catalog.type_showcase
          (id, small_int, big_int, decimal_val, float_val, char_val, varchar_val, text_val,
           bool_val, date_val, ts_val, tstz_val, json_val, uuid_val, bytes_val)
        VALUES
          (99, -1, -9007199254740991, -0.125, -2.5, 'zzzzz', 'O''Brien 100%', E'; DROP TABLE --',
           false, DATE '2026-12-31', TIMESTAMP '2026-12-31 23:59:59',
           TIMESTAMPTZ '2026-12-31 23:59:59+00', '{"a": [1, 2]}',
           '99999999-8888-7777-6666-555555555555', '\\xff00')
      `);

      try {
        const data = await run<{ catalog_type_showcase_single: Record<string, unknown> }>(`
          query {
            catalog_type_showcase_single(where: { id: { eq: 99 } }) {
              small_int big_int decimal_val float_val char_val varchar_val text_val
              bool_val date_val json_val uuid_val
            }
          }
        `);

        expect(data.catalog_type_showcase_single).toMatchObject({
          small_int: -1,
          big_int: -9007199254740991,
          decimal_val: -0.125,
          float_val: -2.5,
          char_val: "zzzzz",
          varchar_val: "O'Brien 100%",
          text_val: "; DROP TABLE --",
          bool_val: false,
          date_val: "2026-12-31",
          json_val: { a: [1, 2] },
          uuid_val: "99999999-8888-7777-6666-555555555555",
        });
      } finally {
        await sql(`DELETE FROM catalog.type_showcase WHERE id = 99`);
      }
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

  describe("stored procedures", () => {
    // The generated Mutation type carries stored procedures, queue publishers,
    // operations and remote fields only — Graphoria generates no insert/update/
    // delete resolvers, so the plan's "every mutation path" reduces to this one.
    it("exposes a stored function as a mutation field", async () => {
      const response = await gql<{ app_tasks_by_priority: boolean }>(
        `mutation { app_tasks_by_priority(min_priority: "4") }`,
      );

      expect(response.errors ?? []).toEqual([]);
      expect(typeof response.data?.app_tasks_by_priority).toBe("boolean");
    });
  });
});

describe.skipIf(!integrationEnabled)("query · pg · virtual columns", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer({
      engine: ENGINE,
      skipSeed: true,
      config: {
        databases: [
          {
            name: "default",
            enabled: true,
            type: ENGINE,
            connection: {
              host: "127.0.0.1",
              port: 55432,
              user: "postgres",
              password: "graphoria_test",
              database: "graphoria_test",
            },
            schema: {
              excludedTables: UNSUPPORTED_IDENTIFIER_TABLES(ENGINE),
              database: {
                app_users: {
                  columns: [
                    virtualColumnExpression(
                      "name_and_email",
                      "varchar",
                      true,
                      `display_name || ' <' || email || '>'`,
                    ),
                    virtualColumnFunction("name_length", "int", true, "LENGTH", ["display_name"]),
                  ],
                },
              },
            },
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await started?.stop();
  });

  it("selects both virtual column forms", async () => {
    const response = await started.context.gql<{
      app_users_single: { name_and_email: string; name_length: number };
    }>(`
      query {
        app_users_single(where: { id: { eq: 1 } }) { name_and_email name_length }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(response.data?.app_users_single).toEqual({
      name_and_email: "Ana Costa <ana@acme.test>",
      name_length: 9,
    });
  });

  // F6: docs/VIRTUAL_COLUMNS.md promises a virtual column is available to
  // "GraphQL filters and ordering". buildConditions has no virtual-column
  // branch, so `where` emits the alias as if it were a physical column and
  // PostgreSQL rejects the statement with `column t1.name_length does not
  // exist`. Ordering by one takes the same path when it reaches the database.
  it.failing("filters and orders by a virtual column", async () => {
    const response = await started.context.gql<{
      filtered: { id: number }[];
      ordered: { name_length: number }[];
    }>(`
      query {
        filtered: app_users(where: { name_length: { eq: 9 } }) { id }
        ordered: app_users(orderBy: [{ name_length: DESC }]) { name_length }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(response.data?.filtered.map((row) => row.id)).toEqual([1]);
    expect(response.data?.ordered.map((row) => row.name_length)).toEqual([20, 15, 15, 14, 13, 9]);
  });
});

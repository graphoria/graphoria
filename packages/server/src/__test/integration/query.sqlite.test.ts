import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { virtualColumnExpression, virtualColumnFunction } from "../../config/types/virtual-columns";
import { CONNECTIONS } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * The query suite against SQLite: the ground query.pg.test.ts covers, asserted
 * on the rows the engine returns.
 *
 * Deliberate differences from the PostgreSQL suite, all engine facts rather than
 * omissions:
 *   - The app tables live in the main file, so their fields start `main_`;
 *     catalog is a second file attached as a schema.
 *   - Timestamps are text in SQLite and come back as written
 *     (`2026-05-01 10:30:00`), and `json_val` is its JSON text, as on SQL Server.
 *   - @dateFormat takes a strftime format.
 *   - SQLite has no stored procedures, so there is no mutation to call.
 *   - The catalog has no array column: `pg_only_types` is PostgreSQL-only.
 */

const ENGINE = "sqlite" as const;

describe.skipIf(!integrationEnabled)("query · sqlite", () => {
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
          eq:  main_tasks(where: { priority: { eq: 5 } })  { id }
          neq: main_tasks(where: { priority: { neq: 5 } }) { id }
          gt:  main_tasks(where: { priority: { gt: 4 } })  { id }
          gte: main_tasks(where: { priority: { gte: 4 } }) { id }
          lt:  main_tasks(where: { priority: { lt: 2 } })  { id }
          lte: main_tasks(where: { priority: { lte: 2 } }) { id }
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
          numeric: main_tasks(where: { priority: { in: [1, 2] } }) { id }
          text: main_users(where: { email: { in: ["ana@acme.test", "dan@umbrella.test"] } }) { id }
        }
      `);

      expect(ids(data.numeric)).toEqual([3, 5, 8, 10]);
      expect(ids(data.text)).toEqual([1, 4]);
    });

    it("is_null, in both directions", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          isNull:    main_tasks(where: { estimate_hours: { is_null: true } })  { id }
          isNotNull: main_tasks(where: { estimate_hours: { is_null: false } }) { id }
        }
      `);

      expect(ids(data.isNull)).toEqual([2, 5, 10]);
      expect(ids(data.isNotNull)).toEqual([1, 3, 4, 6, 7, 8, 9]);
    });

    it("not_null, in both directions", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          notNull: main_tasks(where: { estimate_hours: { not_null: true } })  { id }
          nulls:   main_tasks(where: { estimate_hours: { not_null: false } }) { id }
        }
      `);

      expect(ids(data.notNull)).toEqual([1, 3, 4, 6, 7, 8, 9]);
      expect(ids(data.nulls)).toEqual([2, 5, 10]);
    });

    it("between", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { main_tasks(where: { priority: { between: [2, 4] } }) { id } }
      `);

      expect(ids(data.main_tasks)).toEqual([2, 4, 5, 8, 9]);
    });

    it("like treats %, _ and \\ in the data as literals when escaped", async () => {
      const data = await run<Record<string, { id: number; name: string }[]>>(
        `
        query Q($pct: String, $underscore: String, $backslash: String) {
          pct:        main_tags(where: { name: { like: $pct } })        { id name }
          underscore: main_tags(where: { name: { like: $underscore } }) { id name }
          backslash:  main_tags(where: { name: { like: $backslash } })  { id name }
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
        `query Q($p: String) { main_tags(where: { name: { like: $p } }) { name } }`,
        { p: "%score" },
      );

      expect(data.main_tags?.map((row) => row.name)).toEqual(["under_score"]);
    });

    it("filters through a relationship", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          main_tasks(where: { main_projects: { name: { eq: "Cascade" } } }) { id }
        }
      `);

      expect(ids(data.main_tasks)).toEqual([7, 8, 9, 10]);
    });
  });

  describe("pagination", () => {
    it("limit caps the row count", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { main_tasks(limit: 3, orderBy: [{ id: ASC }]) { id } }
      `);

      expect(data.main_tasks?.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it("offset skips rows", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { main_tasks(limit: 3, offset: 2, orderBy: [{ id: ASC }]) { id } }
      `);

      expect(data.main_tasks?.map((row) => row.id)).toEqual([3, 4, 5]);
    });

    it("keeps the requested order across the page boundary", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          page1: main_tasks(limit: 4, orderBy: [{ priority: DESC }, { id: ASC }]) { id }
          page2: main_tasks(limit: 4, offset: 4, orderBy: [{ priority: DESC }, { id: ASC }]) { id }
        }
      `);

      expect(data.page1?.map((row) => row.id)).toEqual([1, 6, 7, 4]);
      expect(data.page2?.map((row) => row.id)).toEqual([9, 2, 5, 8]);
    });

    it("paginates without an order argument", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query { main_tasks(limit: 2) { id } }
      `);

      expect(data.main_tasks).toHaveLength(2);
    });
  });

  describe("ordering", () => {
    it("ASC and DESC", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          asc:  main_tasks(orderBy: [{ id: ASC }])  { id }
          desc: main_tasks(orderBy: [{ id: DESC }]) { id }
        }
      `);

      expect(data.asc?.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(data.desc?.map((row) => row.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it("every NULLS FIRST / NULLS LAST variant", async () => {
      const data = await run<Record<string, { id: number; estimate_hours: number | null }[]>>(`
        query {
          ascFirst:  main_tasks(orderBy: [{ estimate_hours: ASC_NULLS_FIRST }])  { id estimate_hours }
          ascLast:   main_tasks(orderBy: [{ estimate_hours: ASC_NULLS_LAST }])   { id estimate_hours }
          descFirst: main_tasks(orderBy: [{ estimate_hours: DESC_NULLS_FIRST }]) { id estimate_hours }
          descLast:  main_tasks(orderBy: [{ estimate_hours: DESC_NULLS_LAST }])  { id estimate_hours }
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
        query { main_tasks(orderBy: [{ priority: ASC }, { id: DESC }]) { id priority } }
      `);

      expect(data.main_tasks?.slice(0, 2).map((row) => row.id)).toEqual([10, 3]);
    });
  });

  describe("relationships", () => {
    it("traverses forward two levels", async () => {
      const data = await run<{
        main_tasks_single: {
          id: number;
          main_projects: { name: string; main_organizations: { slug: string } };
        };
      }>(`
        query {
          main_tasks_single(where: { id: { eq: 9 } }) {
            id
            main_projects { name main_organizations { slug } }
          }
        }
      `);

      expect(data.main_tasks_single.main_projects.name).toBe("Cascade");
      expect(data.main_tasks_single.main_projects.main_organizations.slug).toBe("umbrella");
    });

    it("traverses in reverse two levels", async () => {
      const data = await run<{
        main_organizations: {
          id: number;
          main_projects: { id: number; main_tasks: { id: number }[] }[];
        }[];
      }>(`
        query {
          main_organizations(orderBy: [{ id: ASC }]) {
            id
            main_projects(orderBy: [{ id: ASC }]) { id main_tasks(orderBy: [{ id: ASC }]) { id } }
          }
        }
      `);

      const acme = data.main_organizations.find((row) => row.id === 1);
      expect(acme?.main_projects.map((project) => project.id)).toEqual([1, 2]);
      expect(
        acme?.main_projects.flatMap((project) => project.main_tasks.map((task) => task.id)),
      ).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("resolves the self-referential FK in both directions", async () => {
      const data = await run<{
        main_users_single: {
          id: number;
          main_users_ref: { display_name: string } | null;
          main_users_list: { id: number }[];
        };
      }>(`
        query {
          main_users_single(where: { id: { eq: 1 } }) {
            id
            main_users_ref { display_name }
            main_users_list(orderBy: [{ id: ASC }]) { id }
          }
        }
      `);

      expect(data.main_users_single.main_users_ref).toBeNull();
      expect(data.main_users_single.main_users_list.map((row) => row.id)).toEqual([2, 3]);
    });

    it("resolves a many-to-many through its join table", async () => {
      const data = await run<{
        main_tags_single: { name: string; main_task_tags: { main_tasks: { title: string } }[] };
      }>(`
        query {
          main_tags_single(where: { id: { eq: 1 } }) {
            name
            main_task_tags { main_tasks { title } }
          }
        }
      `);

      expect(
        data.main_tags_single.main_task_tags.map((row) => row.main_tasks.title).sort(),
      ).toEqual(["Draft spec", "Review spec", "Umbrella kickoff"]);
    });

    it("serves a view like a table", async () => {
      const data = await run<{ main_open_tasks: { id: number }[] }>(`
        query { main_open_tasks { id } }
      `);

      expect(ids(data.main_open_tasks)).toEqual([1, 2, 4, 5, 7, 8, 9]);
    });
  });

  describe("aggregates", () => {
    it("groups with count, min, max, sum and avg", async () => {
      const data = await run<{
        main_tasks_aggregate: {
          key: { project_id: number };
          count: number;
          min: { priority: number };
          max: { priority: number };
          sum: { priority: number };
          avg: { priority: number };
        }[];
      }>(`
        query {
          main_tasks_aggregate(groupBy: [project_id]) {
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
        data.main_tasks_aggregate.map((group) => [group.key.project_id, group]),
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
        main_tasks_aggregate: {
          key: { project_id: number };
          count: number;
          items: { id: number }[];
        }[];
      }>(`
        query {
          main_tasks_aggregate(where: { completed: { eq: true } }, groupBy: [project_id]) {
            key { project_id }
            count
            items { id }
          }
        }
      `);

      const groups = Object.fromEntries(
        data.main_tasks_aggregate.map((group) => [group.key.project_id, group]),
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
          user: main_users_single(where: { id: { eq: 1 } }) {
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
            formatted: created_at @dateFormat(format: "%Y-%m-%d")
          }
          task: main_tasks_single(where: { id: { eq: 1 } }) {
            rounded:  estimate_hours @round(decimals: 0)
            ceiled:   estimate_hours @ceil
            floored:  estimate_hours @floor
            absolute: estimate_hours @abs
            doubled:  estimate_hours @multiply(by: 2)
            halved:   estimate_hours @divide(by: 2)
          }
          nullable: main_tasks_single(where: { id: { eq: 2 } }) {
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

    it("@concat prepends and appends", async () => {
      const data = await run<{ main_users_single: { prefixed: string; suffixed: string } }>(`
        query {
          main_users_single(where: { id: { eq: 1 } }) {
            prefixed: display_name @concat(with: "X-", position: "before")
            suffixed: display_name @concat(with: "-X")
          }
        }
      `);

      expect(data.main_users_single).toEqual({
        prefixed: "X-Ana Costa",
        suffixed: "Ana Costa-X",
      });
    });

    it("chains directives left to right", async () => {
      const data = await run<{ main_users_single: { display_name: string } }>(`
        query {
          main_users_single(where: { id: { eq: 1 } }) {
            display_name @uppercase @truncate(length: 3)
          }
        }
      `);

      expect(data.main_users_single.display_name).toBe("ANA");
    });

    it("@when includes a field only when its variables are truthy", async () => {
      const included = await run<{ main_users_single: Record<string, unknown> }>(
        `query Q($show: Boolean!) {
          main_users_single(where: { id: { eq: 1 } }) { id email @when(and: [$show]) }
        }`,
        { show: true },
      );

      const excluded = await run<{ main_users_single: Record<string, unknown> }>(
        `query Q($show: Boolean!) {
          main_users_single(where: { id: { eq: 1 } }) { id email @when(and: [$show]) }
        }`,
        { show: false },
      );

      expect(included.main_users_single).toEqual({ id: 1, email: "ana@acme.test" });
      expect(excluded.main_users_single).toEqual({ id: 1 });
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

      expect(String(populated?.["ts_val"])).toStartWith("2026-05-01 10:30:00");
      expect(String(populated?.["tstz_val"])).toStartWith("2026-05-01 10:30:00");
      expect(populated?.["json_val"]).toBe('{"k": "v"}');
      expect(String(populated?.["bytes_val"])).toContain("0102");

      expect(Object.values(empty ?? {}).filter((value) => value === null)).toHaveLength(14);
    });

    it("round-trips a written row through the read path", async () => {
      await sql(`
        INSERT INTO catalog.type_showcase
          (id, small_int, big_int, decimal_val, float_val, char_val, varchar_val, text_val,
           bool_val, date_val, ts_val, tstz_val, json_val, uuid_val, bytes_val)
        VALUES
          (99, -1, -9007199254740991, -0.125, -2.5, 'zzzzz', 'O''Brien 100%', '; DROP TABLE --',
           FALSE, '2026-12-31', '2026-12-31 23:59:59',
           '2026-12-31 23:59:59+00:00', '{"a": [1, 2]}',
           '99999999-8888-7777-6666-555555555555', x'ff00')
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
          json_val: '{"a": [1, 2]}',
          uuid_val: "99999999-8888-7777-6666-555555555555",
        });
      } finally {
        await sql(`DELETE FROM catalog.type_showcase WHERE id = 99`);
      }
    });

    // The runtime builds the response JSON itself rather than running graphql-js
    // serialization, so a wrong scalar in the SDL never errors — it just makes
    // the published schema a lie and breaks client codegen.
    it("declares the type it actually returns", async () => {
      const introspection = await run<{
        __schema: {
          types: {
            name: string;
            fields?: {
              name: string;
              type: { name: string | null; ofType: { name: string } | null };
            }[];
          }[];
        };
      }>(`query { __schema { queryType { name } } }`);

      const fieldType = (typeName: string, fieldName: string) => {
        const type = introspection.__schema.types.find((t) => t.name === typeName);
        const field = type?.fields?.find((f) => f.name === fieldName);
        return field?.type.name ?? field?.type.ofType?.name;
      };

      expect(fieldType("main_projects", "budget")).toBe("Float");
      expect(fieldType("catalog_type_showcase", "decimal_val")).toBe("Float");
      expect(fieldType("main_tasksAvg", "priority")).toBe("Float");
      expect(fieldType("main_tasksMin", "priority")).toBe("Int");
      expect(fieldType("main_tasksSum", "priority")).toBe("Int");
      expect(fieldType("catalog_type_showcase", "bool_val")).toBe("Boolean");
    });

    it("accepts a fractional filter on a decimal column", async () => {
      const data = await run<Record<string, { id: number }[]>>(`
        query {
          main_projects(where: { budget: { gt: 10000.25 } }) { id }
        }
      `);

      expect(ids(data.main_projects)).toEqual([1]);
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

describe.skipIf(!integrationEnabled)("query · sqlite · virtual columns", () => {
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
            connection: { ...CONNECTIONS.sqlite },
            schema: {
              database: {
                main_users: {
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
      main_users_single: { name_and_email: string; name_length: number };
    }>(`
      query {
        main_users_single(where: { id: { eq: 1 } }) { name_and_email name_length }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(response.data?.main_users_single).toEqual({
      name_and_email: "Ana Costa <ana@acme.test>",
      name_length: 9,
    });
  });

  it("filters and orders by a virtual column", async () => {
    const response = await started.context.gql<{
      filtered: { id: number }[];
      ordered: { name_length: number }[];
    }>(`
      query {
        filtered: main_users(where: { name_length: { eq: 9 } }) { id }
        ordered: main_users(orderBy: [{ name_length: DESC }]) { name_length }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
    expect(response.data?.filtered.map((row) => row.id)).toEqual([1]);
    expect(response.data?.ordered.map((row) => row.name_length)).toEqual([19, 15, 15, 14, 13, 9]);
  });
});

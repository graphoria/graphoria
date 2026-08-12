import { describe, expect, it } from "bun:test";

import type { SelectionAnalysis, VariableDefinition } from "../analyzeQuery/types";
import type { MergedEntities } from "../configuration/getSchemas/mergeEntities";

import { buildOrderByClauseFp, buildWhereClauseFp, filterBasedOnDirective } from "./common";

const stubEntities = (overrides: Partial<MergedEntities> = {}): MergedEntities =>
  ({
    queriesMap: {},
    getForeignKeysBetweenTables: () => ({
      relationships: [],
      relationshipsReversed: [],
    }),
    isVirtualColumn: () => undefined,
    ...overrides,
  }) as unknown as MergedEntities;

const field = (args: Record<string, unknown>, name = "users"): SelectionAnalysis => ({
  name,
  arguments: args,
});

const vars = (...names: string[]): VariableDefinition[] =>
  names.map((n) => ({ name: n, type: "String", required: false }));

describe("buildWhereClauseFp", () => {
  describe("placeholder dialect", () => {
    it("emits $N for pg", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        vars("uid"),
        { uid: 1 },
        field({ where: { id: { eq: "$uid" } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.id = $1");
    });

    it("emits $N for mysql", () => {
      const sql = buildWhereClauseFp("mysql")(
        stubEntities(),
        vars("uid"),
        { uid: 1 },
        field({ where: { id: { eq: "$uid" } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.id = $1");
    });

    it("emits @N for mssql", () => {
      const sql = buildWhereClauseFp("mssql")(
        stubEntities(),
        vars("uid"),
        { uid: 1 },
        field({ where: { id: { eq: "$uid" } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.id = @1");
    });
  });

  describe("variable index", () => {
    it("uses 1-based index from variablesDefinition order", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        vars("first", "second", "third"),
        { first: 1, second: 2, third: 3 },
        field({ where: { id: { eq: "$third" } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.id = $3");
    });
  });

  describe("operators", () => {
    const cases: Array<{ op: string; expected: string }> = [
      { op: "eq", expected: "WHERE t1.id = $1" },
      { op: "neq", expected: "WHERE t1.id <> $1" },
      { op: "gt", expected: "WHERE t1.id > $1" },
      { op: "gte", expected: "WHERE t1.id >= $1" },
      { op: "lt", expected: "WHERE t1.id < $1" },
      { op: "lte", expected: "WHERE t1.id <= $1" },
      { op: "like", expected: "WHERE t1.id LIKE $1" },
    ];

    for (const { op, expected } of cases) {
      it(`renders ${op}`, () => {
        const sql = buildWhereClauseFp("pg")(
          stubEntities(),
          vars("v"),
          { v: 1 },
          field({ where: { id: { [op]: "$v" } } }),
          "t1",
          null,
          null,
          0,
          {},
        );
        expect(sql).toBe(expected);
      });
    }

    it("renders IN with array of variable references", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        vars("a", "b", "c"),
        { a: 1, b: 2, c: 3 },
        field({ where: { id: { in: ["$a", "$b", "$c"] } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.id IN ($1, $2, $3)");
    });

    it("renders is_null true → IS NULL", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        [],
        {},
        field({ where: { name: { is_null: true } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.name IS NULL");
    });

    it("renders is_null false → IS NOT NULL", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        [],
        {},
        field({ where: { name: { is_null: false } } }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("WHERE t1.name IS NOT NULL");
    });
  });

  describe("empty input", () => {
    it("returns '' when no where args and no parent join", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        [],
        {},
        field({}),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("");
    });

    it("returns '' when where args present but produce no conditions", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        [],
        {},
        field({ where: {} }),
        "t1",
        null,
        null,
        0,
        {},
      );
      expect(sql).toBe("");
    });
  });

  describe("join with parent table", () => {
    it("appends join condition when parentTableName + parentTableAlias provided", () => {
      const entities = stubEntities({
        getForeignKeysBetweenTables: (() => ({
          relationships: [
            {
              columns: [{ source: "parent_id", target: "id" }],
            },
          ],
          relationshipsReversed: [],
        })) as unknown as MergedEntities["getForeignKeysBetweenTables"],
      });

      const sql = buildWhereClauseFp("pg")(
        entities,
        vars("v"),
        { v: 1 },
        field({ where: { id: { eq: "$v" } } }, "child"),
        "t2",
        "parent",
        "t1",
        0,
        {},
      );
      expect(sql).toBe("WHERE t2.id = $1 AND t1.parent_id = t2.id");
    });
  });

  describe("quoted identifiers", () => {
    it("wraps field names in double quotes when quoted=true", () => {
      const sql = buildWhereClauseFp("pg")(
        stubEntities(),
        vars("v"),
        { v: 1 },
        field({ where: { name: { eq: "$v" } } }),
        "t1",
        null,
        null,
        0,
        {},
        true,
      );
      expect(sql).toBe(`WHERE t1."name" = $1`);
    });
  });
});

describe("buildOrderByClauseFp", () => {
  const entitiesWith = (overrides: Partial<MergedEntities>) => stubEntities(overrides);

  describe("pg native NULLS handling", () => {
    it("renders ASC NULLS FIRST natively", () => {
      const sql = buildOrderByClauseFp("pg")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "ASC_NULLS_FIRST" } }),
        "t1",
      );
      expect(sql).toBe(`ORDER BY t1."name" ASC NULLS FIRST`);
    });

    it("renders DESC NULLS LAST natively", () => {
      const sql = buildOrderByClauseFp("pg")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "DESC_NULLS_LAST" } }),
        "t1",
      );
      expect(sql).toBe(`ORDER BY t1."name" DESC NULLS LAST`);
    });

    it("renders no NULLS clause when direction has none", () => {
      const sql = buildOrderByClauseFp("pg")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "ASC" } }),
        "t1",
      );
      expect(sql).toBe(`ORDER BY t1."name" ASC`);
    });
  });

  describe("mysql CASE synthesis for nulls", () => {
    it("ASC NULLS FIRST → CASE WHEN ... THEN 0 ELSE 1", () => {
      const sql = buildOrderByClauseFp("mysql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "ASC_NULLS_FIRST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY CASE WHEN t1.name IS NULL THEN 0 ELSE 1 END, t1.name ASC");
    });

    it("DESC NULLS LAST → CASE WHEN ... THEN 1 ELSE 0", () => {
      const sql = buildOrderByClauseFp("mysql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "DESC_NULLS_LAST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY CASE WHEN t1.name IS NULL THEN 1 ELSE 0 END, t1.name DESC");
    });
  });

  describe("mssql NULLS handling", () => {
    it("ASC NULLS FIRST → bare order (nulls naturally first on ASC)", () => {
      const sql = buildOrderByClauseFp("mssql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "ASC_NULLS_FIRST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY t1.[name] ASC");
    });

    it("DESC NULLS LAST → bare order (nulls naturally last on DESC)", () => {
      const sql = buildOrderByClauseFp("mssql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "DESC_NULLS_LAST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY t1.[name] DESC");
    });

    it("ASC NULLS LAST → CASE forced", () => {
      const sql = buildOrderByClauseFp("mssql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "ASC_NULLS_LAST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY CASE WHEN t1.name IS NULL THEN 1 ELSE 0 END, t1.name ASC");
    });

    it("DESC NULLS FIRST → CASE forced", () => {
      const sql = buildOrderByClauseFp("mssql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "DESC_NULLS_FIRST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY CASE WHEN t1.name IS NULL THEN 0 ELSE 1 END, t1.name DESC");
    });
  });

  describe("virtual columns", () => {
    it("substitutes the virtual column expression", () => {
      const entities = entitiesWith({
        queriesMap: {},
        isVirtualColumn: ((_t: string, c: string) =>
          c === "full_name"
            ? { virtual: true, expression: "first_name || ' ' || last_name" }
            : undefined) as unknown as MergedEntities["isVirtualColumn"],
      });

      const sql = buildOrderByClauseFp("pg")(
        entities,
        field({ orderBy: { full_name: "ASC" } }),
        "t1",
      );
      expect(sql).toContain("first_name || ' ' || last_name");
      expect(sql).toContain("ASC");
    });
  });

  describe("empty / missing orderBy", () => {
    it("returns '' when no orderBy argument", () => {
      const sql = buildOrderByClauseFp("pg")(entitiesWith({ queriesMap: {} }), field({}), "t1");
      expect(sql).toBe("");
    });
  });

  describe("array of orderBy entries", () => {
    it("joins multiple entries with comma", () => {
      const sql = buildOrderByClauseFp("pg")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: [{ name: "ASC" }, { id: "DESC" }] }),
        "t1",
      );
      expect(sql).toBe(`ORDER BY t1."name" ASC, t1."id" DESC`);
    });
  });
});

describe("filterBasedOnDirective (@when, @skip, @include)", () => {
  describe("@when with `and`", () => {
    it("returns true when all values truthy", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { and: [true, true] } }],
        },
        [],
        {},
      );
      expect(result).toBe(true);
    });

    it("returns false when any value falsy", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { and: [true, false] } }],
        },
        [],
        {},
      );
      expect(result).toBe(false);
    });
  });

  describe("@when with `or`", () => {
    it("returns false when all values falsy", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { or: [false, false] } }],
        },
        [],
        {},
      );
      expect(result).toBe(false);
    });

    it("returns true when any value truthy", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { or: [false, true] } }],
        },
        [],
        {},
      );
      expect(result).toBe(true);
    });
  });

  describe("@when mutual exclusion", () => {
    it("throws when both `and` and `or` supplied", () => {
      expect(() =>
        filterBasedOnDirective(
          {
            name: "x",
            directives: [
              {
                name: "when",
                arguments: { and: [true], or: [true] },
              },
            ],
          },
          [],
          {},
        ),
      ).toThrow(/mutually exclusive/);
    });
  });

  describe("@when variable resolution", () => {
    it("resolves $var from runtime variables", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { and: ["$flag"] } }],
        },
        [{ name: "flag", type: "Boolean", required: false }],
        { flag: true },
      );
      expect(result).toBe(true);
    });

    it("falls back to defaultValue when runtime undefined", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { and: ["$flag"] } }],
        },
        [
          {
            name: "flag",
            type: "Boolean",
            required: false,
            defaultValue: true,
          },
        ],
        {},
      );
      expect(result).toBe(true);
    });

    it("resolves to false when runtime + default both missing", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "when", arguments: { and: ["$flag"] } }],
        },
        [{ name: "flag", type: "Boolean", required: false }],
        {},
      );
      expect(result).toBe(false);
    });

    it("throws when variable definition missing", () => {
      expect(() =>
        filterBasedOnDirective(
          {
            name: "x",
            directives: [{ name: "when", arguments: { and: ["$missing"] } }],
          },
          [],
          {},
        ),
      ).toThrow(/Variable missing not found/);
    });
  });

  describe("@skip / @include precedence", () => {
    it("@skip true → field excluded (returns false)", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "skip", arguments: { if: true } }],
        },
        [],
        {},
      );
      expect(result).toBe(false);
    });

    it("@skip false → field included (returns true)", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "skip", arguments: { if: false } }],
        },
        [],
        {},
      );
      expect(result).toBe(true);
    });

    it("@include true → field included", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "include", arguments: { if: true } }],
        },
        [],
        {},
      );
      expect(result).toBe(true);
    });

    it("@include false → field excluded", () => {
      const result = filterBasedOnDirective(
        {
          name: "x",
          directives: [{ name: "include", arguments: { if: false } }],
        },
        [],
        {},
      );
      expect(result).toBe(false);
    });
  });

  describe("no directives", () => {
    it("returns true when directives array empty", () => {
      const result = filterBasedOnDirective({ name: "x", directives: [] }, [], {});
      expect(result).toBe(true);
    });

    it("returns true when directives undefined", () => {
      const result = filterBasedOnDirective({ name: "x" }, [], {});
      expect(result).toBe(true);
    });
  });
});

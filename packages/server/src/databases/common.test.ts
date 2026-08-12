import { describe, expect, it } from "bun:test";

import type { SelectionAnalysis, VariableDefinition } from "../analyzeQuery/types";
import type { MergedEntities } from "../configuration/getSchemas/mergeEntities";

import {
  buildOrderByClauseFp,
  buildWhereClauseFp,
  filterBasedOnDirective,
  findJoinCondition,
  qualifiedNameFp,
  wrapIdentifierFp,
} from "./common";

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
      expect(sql).toBe('WHERE t1."id" = $1');
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
      expect(sql).toBe("WHERE t1.`id` = $1");
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
      expect(sql).toBe("WHERE t1.[id] = @1");
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
      expect(sql).toBe('WHERE t1."id" = $3');
    });
  });

  describe("operators", () => {
    const cases: Array<{ op: string; expected: string }> = [
      { op: "eq", expected: 'WHERE t1."id" = $1' },
      { op: "neq", expected: 'WHERE t1."id" <> $1' },
      { op: "gt", expected: 'WHERE t1."id" > $1' },
      { op: "gte", expected: 'WHERE t1."id" >= $1' },
      { op: "lt", expected: 'WHERE t1."id" < $1' },
      { op: "lte", expected: 'WHERE t1."id" <= $1' },
      { op: "like", expected: 'WHERE t1."id" LIKE $1' },
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
      expect(sql).toBe('WHERE t1."id" IN ($1, $2, $3)');
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
      expect(sql).toBe('WHERE t1."name" IS NULL');
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
      expect(sql).toBe('WHERE t1."name" IS NOT NULL');
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
      expect(sql).toBe('WHERE t2."id" = $1 AND t1."parent_id" = t2."id"');
    });
  });

  describe("deeply nested relation filters", () => {
    // Regression: a where filter nested 3 relations deep (first -> second -> third) must resolve a
    // join at every hop. The bug left aliasMap[t2] unset, so the innermost EXISTS lost its parent
    // table and emitted a join-less "WHERE  AND (...)".
    const squish = (sql: string): string => sql.replace(/\s+/g, " ").trim();

    const deepEntities = stubEntities({
      queriesMap: {
        second_table: { dottedQuotedName: "second_table", columns: [] },
        third_table: { dottedQuotedName: "third_table", columns: [] },
      } as unknown as MergedEntities["queriesMap"],
      getForeignKeysBetweenTables: ((table1: string, table2: string) => {
        if (table1 === "first_table" && table2 === "second_table") {
          return {
            relationships: [{ columns: [{ source: "second_id", target: "id" }] }],
            relationshipsReversed: [],
          };
        }
        if (table1 === "second_table" && table2 === "third_table") {
          return {
            relationships: [{ columns: [{ source: "third_id", target: "id" }] }],
            relationshipsReversed: [],
          };
        }
        return { relationships: [], relationshipsReversed: [] };
      }) as unknown as MergedEntities["getForeignKeysBetweenTables"],
    });

    const nestedWhere = field(
      { where: { second_table: { third_table: { field: { eq: "$v" } } } } },
      "first_table",
    );

    const cases: Array<{ dbType: "pg" | "mysql" | "mssql"; expected: string }> = [
      {
        dbType: "pg",
        expected:
          'WHERE EXISTS ( SELECT 1 FROM second_table t2 WHERE t1."second_id" = t2."id" AND (EXISTS ( SELECT 1 FROM third_table t3 WHERE t2."third_id" = t3."id" AND (t3."field" = $1) )) )',
      },
      {
        dbType: "mysql",
        expected:
          "WHERE EXISTS ( SELECT 1 FROM second_table t2 WHERE t1.`second_id` = t2.`id` AND (EXISTS ( SELECT 1 FROM third_table t3 WHERE t2.`third_id` = t3.`id` AND (t3.`field` = $1) )) )",
      },
      {
        dbType: "mssql",
        expected:
          "WHERE EXISTS ( SELECT 1 FROM second_table t2 WHERE t1.[second_id] = t2.[id] AND (EXISTS ( SELECT 1 FROM third_table t3 WHERE t2.[third_id] = t3.[id] AND (t3.[field] = @1) )) )",
      },
    ];

    for (const { dbType, expected } of cases) {
      it(`resolves a join at every hop for ${dbType}`, () => {
        const sql = buildWhereClauseFp(dbType)(
          deepEntities,
          vars("v"),
          { v: 1 },
          nestedWhere,
          "t1",
          null,
          null,
          1,
          { t1: "first_table" },
        );
        expect(squish(sql)).toBe(expected);
      });
    }
  });

  describe("quoted identifiers", () => {
    it("wraps field names in double quotes for pg", () => {
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
      );
      expect(sql).toBe(`WHERE t1."name" = $1`);
    });
  });
});

describe("findJoinCondition collation handling", () => {
  const makeEntities = (
    parentCols: Record<string, string | null>,
    childCols: Record<string, string | null>,
    columns: { source: string; target: string }[] = [{ source: "parent_id", target: "id" }],
  ): MergedEntities =>
    stubEntities({
      queriesMap: {
        parent: {
          columns: Object.entries(parentCols).map(([name, collation]) => ({ name, collation })),
        },
        child: {
          columns: Object.entries(childCols).map(([name, collation]) => ({ name, collation })),
        },
      } as unknown as MergedEntities["queriesMap"],
      getForeignKeysBetweenTables: (() => ({
        relationships: [{ columns }],
        relationshipsReversed: [],
      })) as unknown as MergedEntities["getForeignKeysBetweenTables"],
    });

  it("omits COLLATE when both columns share a collation", () => {
    const entities = makeEntities(
      { parent_id: "SQL_Latin1_General_CP1_CI_AS" },
      { id: "SQL_Latin1_General_CP1_CI_AS" },
    );
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "mssql")).toBe(
      "t1.[parent_id] = t2.[id]",
    );
  });

  it("omits COLLATE when a column has no collation (non-character column)", () => {
    const entities = makeEntities({ parent_id: null }, { id: "SQL_Latin1_General_CP1_CI_AS" });
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "mssql")).toBe(
      "t1.[parent_id] = t2.[id]",
    );
  });

  it("appends COLLATE DATABASE_DEFAULT on a mssql mismatch", () => {
    const entities = makeEntities(
      { parent_id: "SQL_Latin1_General_CP1_CI_AS" },
      { id: "Latin1_General_100_CI_AS" },
    );
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "mssql")).toBe(
      "t1.[parent_id] = t2.[id] COLLATE DATABASE_DEFAULT",
    );
  });

  it('appends COLLATE "default" on a pg mismatch', () => {
    const entities = makeEntities({ parent_id: "en_US" }, { id: "C" });
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      't1."parent_id" = t2."id" COLLATE "default"',
    );
  });

  it("coerces to the parent column collation on a mysql mismatch", () => {
    const entities = makeEntities(
      { parent_id: "utf8mb4_general_ci" },
      { id: "utf8mb4_unicode_ci" },
    );
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "mysql")).toBe(
      "t1.`parent_id` = t2.`id` COLLATE utf8mb4_general_ci",
    );
  });

  it("applies COLLATE only to the differing pair of a composite key", () => {
    const entities = makeEntities(
      { a: "utf8mb4_general_ci", b: "utf8mb4_general_ci" },
      { x: "utf8mb4_general_ci", y: "utf8mb4_unicode_ci" },
      [
        { source: "a", target: "x" },
        { source: "b", target: "y" },
      ],
    );
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "mysql")).toBe(
      "t1.`a` = t2.`x` AND t1.`b` = t2.`y` COLLATE utf8mb4_general_ci",
    );
  });
});

describe("findJoinCondition static conditions", () => {
  const joinEntities = (
    relationships: unknown[] = [],
    relationshipsReversed: unknown[] = [],
  ): MergedEntities =>
    stubEntities({
      getForeignKeysBetweenTables: (() => ({
        relationships,
        relationshipsReversed,
      })) as unknown as MergedEntities["getForeignKeysBetweenTables"],
    });

  const relation = (conditions: unknown[]) => ({
    columns: [{ source: "EDT_TYPE", target: "TypeCode" }],
    conditions,
  });

  it("ANDs a target-column condition onto a forward join (child alias)", () => {
    const entities = joinEntities([
      relation([{ target: "Type", operator: "eq", value: "static_value" }]),
    ]);
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t2."Type" = 'static_value'`,
    );
  });

  it("ANDs a source-column condition onto a forward join (parent alias)", () => {
    const entities = joinEntities([relation([{ source: "STATUS", operator: "eq", value: 1 }])]);
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t1."STATUS" = 1`,
    );
  });

  it("flips condition aliases on a reversed join", () => {
    const entities = joinEntities(
      [],
      [
        relation([
          { target: "Type", operator: "eq", value: "x" },
          { source: "FLAG", operator: "eq", value: "y" },
        ]),
      ],
    );
    // reversed: columns map target->parent(t1), source->child(t2);
    // target condition -> parent(t1), source condition -> child(t2)
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."TypeCode" = t2."EDT_TYPE" AND t1."Type" = 'x' AND t2."FLAG" = 'y'`,
    );
  });

  it("defaults the operator to eq when omitted", () => {
    const entities = joinEntities([relation([{ target: "Type", value: "v" }])]);
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t2."Type" = 'v'`,
    );
  });

  it("renders each comparison operator", () => {
    const cases: Array<{ op: string; sql: string }> = [
      { op: "neq", sql: "<>" },
      { op: "gt", sql: ">" },
      { op: "gte", sql: ">=" },
      { op: "lt", sql: "<" },
      { op: "lte", sql: "<=" },
      { op: "like", sql: "LIKE" },
    ];
    for (const { op, sql } of cases) {
      const entities = joinEntities([relation([{ target: "n", operator: op, value: 5 }])]);
      expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
        `t1."EDT_TYPE" = t2."TypeCode" AND t2."n" ${sql} 5`,
      );
    }
  });

  it("renders is_null and is_not_null without a value", () => {
    const nullEntities = joinEntities([relation([{ target: "Type", operator: "is_null" }])]);
    expect(findJoinCondition(nullEntities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t2."Type" IS NULL`,
    );
    const notNullEntities = joinEntities([relation([{ target: "Type", operator: "is_not_null" }])]);
    expect(findJoinCondition(notNullEntities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t2."Type" IS NOT NULL`,
    );
  });

  it("escapes single quotes in string literals", () => {
    const entities = joinEntities([relation([{ target: "name", value: "O'Brien" }])]);
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t2."name" = 'O''Brien'`,
    );
  });

  it("renders booleans per dialect (TRUE/FALSE vs 1/0)", () => {
    const entities = joinEntities([relation([{ target: "active", value: true }])]);
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode" AND t2."active" = TRUE`,
    );
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "mssql")).toBe(
      "t1.[EDT_TYPE] = t2.[TypeCode] AND t2.[active] = 1",
    );
  });

  it("is a no-op when a relationship carries no conditions", () => {
    const entities = joinEntities([{ columns: [{ source: "EDT_TYPE", target: "TypeCode" }] }]);
    expect(findJoinCondition(entities, "parent", "child", "t1", "t2", "pg")).toBe(
      `t1."EDT_TYPE" = t2."TypeCode"`,
    );
  });
});

describe("wrapIdentifierFp", () => {
  it("uses the delimiters of each dialect", () => {
    expect(wrapIdentifierFp("pg")("order")).toBe(`"order"`);
    expect(wrapIdentifierFp("mysql")("order")).toBe("`order`");
    expect(wrapIdentifierFp("mssql")("order")).toBe("[order]");
  });

  it("escapes a closing delimiter by doubling it", () => {
    expect(wrapIdentifierFp("pg")(`we"ird`)).toBe(`"we""ird"`);
    expect(wrapIdentifierFp("mysql")("we`ird")).toBe("`we``ird`");
    expect(wrapIdentifierFp("mssql")("we]ird")).toBe("[we]]ird]");
  });
});

describe("qualifiedNameFp", () => {
  const table = { schema: "dbo", name: "order" };

  it("delimits both parts of the name", () => {
    expect(qualifiedNameFp("pg")(table)).toBe(`"dbo"."order"`);
    expect(qualifiedNameFp("mysql")(table)).toBe("`dbo`.`order`");
    expect(qualifiedNameFp("mssql")(table)).toBe("[dbo].[order]");
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
      expect(sql).toBe("ORDER BY CASE WHEN t1.`name` IS NULL THEN 0 ELSE 1 END, t1.`name` ASC");
    });

    it("DESC NULLS LAST → CASE WHEN ... THEN 1 ELSE 0", () => {
      const sql = buildOrderByClauseFp("mysql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "DESC_NULLS_LAST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY CASE WHEN t1.`name` IS NULL THEN 1 ELSE 0 END, t1.`name` DESC");
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
      expect(sql).toBe("ORDER BY CASE WHEN t1.[name] IS NULL THEN 1 ELSE 0 END, t1.[name] ASC");
    });

    it("DESC NULLS FIRST → CASE forced", () => {
      const sql = buildOrderByClauseFp("mssql")(
        entitiesWith({ queriesMap: {} }),
        field({ orderBy: { name: "DESC_NULLS_FIRST" } }),
        "t1",
      );
      expect(sql).toBe("ORDER BY CASE WHEN t1.[name] IS NULL THEN 0 ELSE 1 END, t1.[name] DESC");
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

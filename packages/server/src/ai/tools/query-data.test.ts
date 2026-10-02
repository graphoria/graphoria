process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";
import { parse, valueFromASTUntyped } from "graphql";

import type { FieldNode, OperationDefinitionNode } from "graphql";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { columnFieldName } = await import("../../databases/transformers/graphqlName");
const { buildStructuredQuery, queryDataSchema } = await import("./query-data");
const { tableFieldNames } = await import("./core");

const role = getSchema({
  tables: StoreMSSQL.tables,
  storedProcedures: [],
  queues: [],
  operations: {},
  remoteSchemas: [],
  remoteREST: [],
});
const table = role.tables[0]!;
const field = columnFieldName(table.columns[0]!);
const errorsOf = (query: string) =>
  role.handlers.gql.hasErrors(query).validationErrors.map((error) => error.message);

describe("buildStructuredQuery", () => {
  it("orders by a column in the schema's own shape", () => {
    const query = buildStructuredQuery({
      entity: table.resolverName,
      operation: "list",
      columns: [field],
      orderBy: [{ column: field, direction: "DESC" }],
      limit: 5,
    });

    expect(query).toContain(`orderBy: [{ ${field}: DESC }]`);
    expect(errorsOf(query)).toEqual([]);
  });

  it("selects every readable column when a list names none", () => {
    const query = buildStructuredQuery(
      { entity: table.resolverName, operation: "list", limit: 5 },
      tableFieldNames(role, table.resolverName),
    );

    for (const column of table.columns) expect(query).toContain(columnFieldName(column));
    expect(errorsOf(query)).toEqual([]);
  });

  it("refuses a list naming no column on an entity that is not a table", () => {
    expect(() =>
      buildStructuredQuery(
        { entity: "nope", operation: "list", limit: 5 },
        tableFieldNames(role, "nope"),
      ),
    ).toThrow(/columns/);
  });

  it("refuses a filter key that is not a GraphQL name, at any depth", () => {
    expect(() =>
      buildStructuredQuery({
        entity: table.resolverName,
        operation: "list",
        columns: [field],
        limit: 1,
        filters: { [field]: { "eq: 1 }) { x } y(z": 1 } },
      }),
    ).toThrow(/GraphQL name/);
  });

  it("refuses a filter key that is not a GraphQL name inside a list", () => {
    expect(() =>
      buildStructuredQuery({
        entity: table.resolverName,
        operation: "list",
        columns: [field],
        limit: 1,
        filters: { _or: [{ "bad name": { eq: 1 } }] },
      }),
    ).toThrow(/GraphQL name/);
  });

  it("builds a grouped aggregate the role's schema accepts", () => {
    const query = buildStructuredQuery({
      entity: table.resolverName,
      operation: "aggregate",
      groupBy: [field],
      columns: [field],
      filters: { [field]: { gt: 0 } },
      limit: 5,
    });

    expect(query).toContain(`${table.resolverName}_aggregate(groupBy: [${field}]`);
    expect(errorsOf(query)).toEqual([]);
  });

  // JSON, as a tool call carries it: a literal `__proto__` key would set the prototype instead.
  it.each([
    ["__proto__ at the top", `{ "__proto__": { "eq": 1 }, "${field}": { "eq": 2 } }`],
    ["__typename at the top", `{ "__typename": { "eq": 1 } }`],
    ["__proto__ nested", `{ "${field}": { "__proto__": { "eq": 1 } } }`],
    ["__typename nested in a list", `{ "_or": [{ "__typename": { "eq": 1 } }] }`],
  ])("refuses a reserved filter key: %s", (_, filters) => {
    expect(() =>
      buildStructuredQuery({
        entity: table.resolverName,
        operation: "list",
        columns: [field],
        limit: 1,
        filters: JSON.parse(filters),
      }),
    ).toThrow(/reserved/);
  });

  it("keeps hostile filter values inside their string literals", () => {
    const hostile = [
      '"} injected: x {"',
      'it\'s "quoted"',
      "{ braces } [ and brackets ]",
      "back\\slash\\",
      "new\nline",
      '"} } query { x } #',
    ];
    const filters = { _or: hostile.map((value) => ({ [field]: { eq: value } })) };

    const document = parse(
      buildStructuredQuery({
        entity: table.resolverName,
        operation: "list",
        columns: [field],
        limit: 1,
        filters,
      }),
    );

    expect(document.definitions).toHaveLength(1);
    const [operation] = document.definitions as OperationDefinitionNode[];
    expect(operation!.selectionSet.selections).toHaveLength(1);
    const [root] = operation!.selectionSet.selections as FieldNode[];
    const where = root!.arguments!.find((argument) => argument.name.value === "where")!;
    expect(valueFromASTUntyped(where.value)).toEqual(filters);
  });

  it("refuses a name that is not a GraphQL name when called directly", () => {
    expect(() =>
      buildStructuredQuery({
        entity: "x { __typename } injected",
        operation: "list",
        columns: [field],
        limit: 1,
      }),
    ).toThrow(/GraphQL name/);
  });

  it("refuses offset and orderBy on an aggregate instead of dropping them", () => {
    const aggregate = {
      entity: table.resolverName,
      operation: "aggregate" as const,
      groupBy: [field],
      limit: 5,
    };

    expect(() => buildStructuredQuery({ ...aggregate, offset: 10 })).toThrow(
      "aggregate takes no offset or orderBy",
    );
    expect(() =>
      buildStructuredQuery({ ...aggregate, orderBy: [{ column: field, direction: "ASC" }] }),
    ).toThrow("aggregate takes no offset or orderBy");
  });

  it("accepts offset 0 on an aggregate: it skips nothing", () => {
    const query = buildStructuredQuery({
      entity: table.resolverName,
      operation: "aggregate",
      groupBy: [field],
      limit: 5,
      offset: 0,
    });

    expect(query).not.toContain("offset");
    expect(errorsOf(query)).toEqual([]);
  });
});

describe("queryDataSchema", () => {
  it.each([
    ["entity", { entity: "t { x } y", operation: "list" }],
    ["column", { entity: "t", operation: "list", columns: ["id } x {"] }],
    ["groupBy", { entity: "t", operation: "aggregate", groupBy: ["a b"] }],
    ["orderBy column", { entity: "t", operation: "list", orderBy: [{ column: "a) {" }] }],
    ["filter key", { entity: "t", operation: "list", filters: { "a b": { eq: 1 } } }],
  ])("rejects a %s that is not a GraphQL name", (_, input) => {
    expect(queryDataSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a __proto__ filter key rather than dropping it", () => {
    const input = { entity: "t", operation: "list", filters: JSON.parse('{ "__proto__": {} }') };

    expect(queryDataSchema.safeParse(input).success).toBe(false);
  });
});

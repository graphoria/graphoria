process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterAll, describe, expect, it } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

import type { BunRequest } from "bun";
import type { SchemaEntities } from "../../configuration/getSchemas";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { AiToolDeps, RoleEntities } from "../adapter";

const { env } = await import("../../singletons/env");
const { makeAiToolDeps } = await import("../../singletons/ai");
const { handleGraphQLRequestFactory } =
  await import("../../configuration/gql/handleGraphQLRequestFactory");
const { describeEntityCore, executeGraphqlCore, makeValidateQuery } =
  await import("../../../../ai/src/tools/core");

const sdl = `
  type Query {
    users(limit: Int): [User!]!
  }
  type User {
    id: ID!
    name: String!
    posts(limit: Int): [Post!]!
  }
  type Post {
    id: ID!
    title: String!
  }
`;

const schema = buildSchema(sdl);

const entities: SchemaEntities = {
  ...({ getResolverSource: () => undefined } as Partial<MergedEntities> as MergedEntities),
  typeDefs: sdl,
  schema,
  introspection: introspectionFromSchema(schema),
};

const role = {
  schema,
  handlers: { gql: handleGraphQLRequestFactory(entities) },
} as unknown as RoleEntities;

const PAGINATED = "query ($n: Int) { users(limit: $n) { id name posts { id } } }";

// `validateQuery` below is created at describe-evaluation time, so `deps` must
// exist then too — a `beforeAll` assignment would arrive too late for it.
const previousCost = env.maxQueryCost;
env.maxQueryCost = 10_000;
const deps: AiToolDeps = makeAiToolDeps(env);

afterAll(() => {
  env.maxQueryCost = previousCost;
});

describe("makeValidateQuery — cost limit", () => {
  describe("delegating to the role's own validator", () => {
    const validateQuery = makeValidateQuery(deps, role);

    it("passes a query its variables keep within budget", () => {
      expect(validateQuery(PAGINATED, { n: 1 }).hasErrors).toBe(false);
    });

    it("rejects the query its variables make expensive", () => {
      const result = validateQuery(PAGINATED, { n: 1000 });

      expect(result.hasErrors).toBe(true);
      expect(result.validationErrors[0]?.message).toContain("exceeds the maximum allowed cost");
    });
  });

  describe("with its own depth override", () => {
    const validateQuery = makeValidateQuery(deps, role, 20);

    it("passes a query its variables keep within budget", () => {
      expect(validateQuery(PAGINATED, { n: 1 }).hasErrors).toBe(false);
    });

    it("still budgets a query the depth override lets through", () => {
      const result = validateQuery(PAGINATED, { n: 1000 });

      expect(result.hasErrors).toBe(true);
      expect(result.validationErrors[0]?.message).toContain("exceeds the maximum allowed cost");
    });

    it("still rejects a query that does not typecheck", () => {
      expect(validateQuery("query { not_a_field }").hasErrors).toBe(true);
    });
  });

  it("budgets a tool call against the variables it was handed", async () => {
    const validateQuery = makeValidateQuery(deps, role);

    const outcome = await executeGraphqlCore(
      deps,
      role,
      validateQuery,
      { query: PAGINATED, variables: { n: 1000 } },
      {},
    );

    expect(outcome.kind).toBe("validation");
  });
});

describe("executeGraphqlCore — the caller", () => {
  const recording = () => {
    const calls: unknown[][] = [];
    const role = {
      schema,
      handlers: {
        gql: {
          hasErrors: () => ({ hasErrors: false, validationErrors: [] }),
          handler: async (...args: unknown[]) => {
            calls.push(args);
            return { data: {} };
          },
        },
      },
    } as unknown as RoleEntities;
    return { calls, role };
  };

  it("runs the query with the caller's session and request", async () => {
    const { calls, role: recorded } = recording();
    const session = { sub: "ana@acme.test", role: "user", claims: { userId: 1 } };
    const req = new Request("http://graphoria.test/graphql", {
      headers: { authorization: "Bearer token" },
    }) as unknown as BunRequest;

    await executeGraphqlCore(
      deps,
      recorded,
      makeValidateQuery(deps, recorded),
      { query: "{ users { id } }" },
      { session, req },
    );

    expect(calls[0]![2]).toBe(req);
    expect(calls[0]![3]).toBe(session);
  });

  it("stands in a request when the caller brings none", async () => {
    const { calls, role: recorded } = recording();

    await executeGraphqlCore(
      deps,
      recorded,
      makeValidateQuery(deps, recorded),
      { query: "{ users { id } }" },
      {},
    );

    expect(calls[0]![2]).toBeInstanceOf(Request);
    expect(calls[0]![3]).toBeUndefined();
  });
});

describe("executeGraphqlCore — the agent's own field", () => {
  const askSdl = `
    type Query {
      ask(prompt: String!): String!
      notes: [Note!]!
    }
    type Note {
      ask: String!
    }
  `;

  const recording = () => {
    const queries: unknown[] = [];
    const role = {
      schema: buildSchema(askSdl),
      handlers: {
        gql: {
          hasErrors: () => ({ hasErrors: false, validationErrors: [] }),
          handler: async (query: unknown) => {
            queries.push(query);
            return { data: {} };
          },
        },
      },
    } as unknown as RoleEntities;
    return { queries, role };
  };

  it.each([
    '{ ask(prompt: "x") }',
    '{ answer: ask(prompt: "x") }',
    'query { ...Ask } fragment Ask on Query { ask(prompt: "x") }',
    '{ ... on Query { ask(prompt: "x") } }',
    '{ __typename ask(prompt: "x") }',
  ])("refuses %s without running it", async (query) => {
    const { queries, role } = recording();

    const outcome = await executeGraphqlCore(
      deps,
      role,
      makeValidateQuery(deps, role),
      { query },
      {},
    );

    expect(outcome).toEqual({
      kind: "error",
      message: "`ask` cannot run inside a tool call: it would start the agent again.",
    });
    expect(queries).toEqual([]);
  });

  it("runs a query selecting a column named ask", async () => {
    const { queries, role } = recording();

    const outcome = await executeGraphqlCore(
      deps,
      role,
      makeValidateQuery(deps, role),
      { query: "{ notes { ask } }" },
      {},
    );

    expect(outcome.kind).toBe("ok");
    expect(queries).toHaveLength(1);
  });
});

describe("describeEntityCore", () => {
  const sdlWithAccents = `
    type Query { shop_people(limit: Int, where: shop_peopleWhereInput): [shop_people!]! }
    input shop_peopleWhereInput { first_name: StringCondition }
    input StringCondition { like: String }
    type shop_people { first_name: String! }
  `;

  const idColumn = { name: "id", fieldName: "id", dataType: "int", isNullable: false };
  const joining = (from: string, to: string, source: string, target: string, suffix = "") => ({
    fromInternalName: from,
    fromResolverName: `${from}${suffix}`,
    toInternalName: to,
    toResolverName: `${to}${suffix}`,
    columns: [{ source, target }],
  });
  // The role reads `customer id`, but neither `seller ref` nor `région code`.
  const toCustomer = joining("shop_orders", "shop_customers", "customer id", "id");
  const toSeller = joining("shop_orders", "shop_sellers", "seller ref", "id");
  const toRegion = joining("shop_orders", "shop_regions", "region", "région code");
  // Two foreign keys to one table: each relationship field carries a suffix the
  // table names do not.
  const fromAccount = joining("shop_transfers", "shop_accounts", "from acct", "id", "_from_acct");
  const toAccount = joining("shop_transfers", "shop_accounts", "to acct", "id", "_to_acct");
  const joined = (name: string, relationshipsReversed: unknown[]) => ({
    resolverName: name,
    schema: "shop",
    name,
    tableDescription: null,
    columns: [idColumn],
    relationships: [],
    relationshipsReversed,
  });

  const describing = {
    schema: buildSchema(sdlWithAccents),
    tables: [
      {
        resolverName: "shop_people",
        schema: "shop",
        name: "people",
        tableDescription: null,
        columns: [
          { name: "first name", fieldName: "first_name", dataType: "varchar", isNullable: false },
        ],
        relationships: [],
        relationshipsReversed: [],
      },
      {
        resolverName: "shop_stock",
        schema: "shop",
        name: "stock",
        tableDescription: null,
        columns: [
          { name: "units left", fieldName: "units_left", dataType: "int", isNullable: false },
        ],
        relationships: [],
        relationshipsReversed: [],
      },
      {
        resolverName: "shop_flags",
        schema: "shop",
        name: "flags",
        tableDescription: null,
        columns: [
          { name: "is listed", fieldName: "is_listed", dataType: "boolean", isNullable: false },
        ],
        relationships: [],
        relationshipsReversed: [],
      },
      {
        resolverName: "shop_orders",
        schema: "shop",
        name: "orders",
        tableDescription: null,
        columns: [
          idColumn,
          { name: "customer id", fieldName: "customer_id", dataType: "int", isNullable: false },
          { name: "region", fieldName: "region", dataType: "int", isNullable: false },
        ],
        relationships: [toCustomer, toSeller, toRegion],
        relationshipsReversed: [],
      },
      joined("shop_customers", [toCustomer]),
      joined("shop_sellers", [toSeller]),
      joined("shop_regions", [toRegion]),
      {
        resolverName: "shop_transfers",
        schema: "shop",
        name: "transfers",
        tableDescription: null,
        columns: [
          idColumn,
          { name: "from acct", fieldName: "from_acct", dataType: "int", isNullable: false },
          { name: "to acct", fieldName: "to_acct", dataType: "int", isNullable: false },
        ],
        relationships: [fromAccount, toAccount],
        relationshipsReversed: [],
      },
      joined("shop_accounts", [fromAccount, toAccount]),
    ],
    remoteSchemas: [
      {
        config: { name: "billing", url: "http://billing.internal:8080/graphql" },
        prefix: "billing",
        queryFields: [],
        mutationFields: [],
        typeDefsSDL: "",
      },
    ],
    remoteRESTApis: [
      {
        config: { name: "payments" },
        baseUrl: "http://payments.internal:9090",
        prefix: "payments",
        routes: [],
        openApiPaths: {},
        openApiSchemas: {},
      },
    ],
    storedProcedures: [],
    queuesMap: {},
    operations: {},
  } as unknown as RoleEntities;

  it("names a table's columns as their GraphQL fields", () => {
    const described = describeEntityCore(deps, describing, {
      name: "shop_people",
      kind: "table",
    }) as {
      columns: { name: string }[];
      examples: { list: string; filter: string; aggregate: string };
    };

    expect(described.columns.map((column) => column.name)).toEqual(["first_name"]);
    expect(JSON.stringify(described.examples)).toContain("first_name");
    expect(JSON.stringify(described.examples)).not.toContain("first name");
  });

  it("names the numeric and boolean filters and the sums by their GraphQL fields", () => {
    const examplesOf = (name: string) =>
      (
        describeEntityCore(deps, describing, { name, kind: "table" }) as {
          examples: { filter: string; aggregate: string };
        }
      ).examples;
    const stock = examplesOf("shop_stock");
    const flags = examplesOf("shop_flags");

    expect(stock.filter).toContain("where: { units_left: { gt: 0 } }");
    expect(stock.aggregate).toContain("sum { units_left }");
    expect(stock.aggregate).toContain("avg { units_left }");
    expect(flags.filter).toContain("where: { is_listed: { eq: true } }");
    expect(JSON.stringify([stock, flags])).not.toMatch(/units left|is listed/);
  });

  it("keeps upstream addresses out of a remote schema or API", () => {
    const text = JSON.stringify([
      describeEntityCore(deps, describing, { name: "billing", kind: "remote_schema" }),
      describeEntityCore(deps, describing, { name: "payments", kind: "remote_rest" }),
    ]);

    expect(text).toContain("billing");
    expect(text).toContain("payments");
    expect(text).not.toContain("internal");
  });

  it("names relationship join columns as GraphQL fields, leaving out the ones the role cannot read", () => {
    const described = Object.fromEntries(
      ["shop_orders", "shop_customers", "shop_sellers", "shop_regions"].map((name) => [
        name,
        describeEntityCore(deps, describing, { name, kind: "table" }) as {
          relationships: unknown[];
          relationshipsReversed: unknown[];
        },
      ]),
    );

    expect(described["shop_orders"]!.relationships).toEqual([
      { to: "shop_customers", columns: [{ from: "customer_id", to: "id" }] },
      { to: "shop_sellers", columns: [] },
      { to: "shop_regions", columns: [] },
    ]);
    expect(described["shop_customers"]!.relationshipsReversed).toEqual([
      { from: "shop_orders", columns: [{ from: "customer_id", to: "id" }] },
    ]);
    expect(described["shop_sellers"]!.relationshipsReversed).toEqual([
      { from: "shop_orders", columns: [] },
    ]);
    expect(described["shop_regions"]!.relationshipsReversed).toEqual([
      { from: "shop_orders", columns: [] },
    ]);

    const text = JSON.stringify(described);
    expect(text).not.toContain("customer id");
    expect(text).not.toContain("seller ref");
    expect(text).not.toContain("région code");
  });

  it("finds join columns by table, not by a relationship's suffixed field name", () => {
    const transfers = describeEntityCore(deps, describing, {
      name: "shop_transfers",
      kind: "table",
    }) as {
      relationships: unknown[];
    };
    const accounts = describeEntityCore(deps, describing, {
      name: "shop_accounts",
      kind: "table",
    }) as {
      relationshipsReversed: unknown[];
    };

    expect(transfers.relationships).toEqual([
      { to: "shop_accounts_from_acct", columns: [{ from: "from_acct", to: "id" }] },
      { to: "shop_accounts_to_acct", columns: [{ from: "to_acct", to: "id" }] },
    ]);
    expect(accounts.relationshipsReversed).toEqual([
      { from: "shop_transfers_from_acct", columns: [{ from: "from_acct", to: "id" }] },
      { from: "shop_transfers_to_acct", columns: [{ from: "to_acct", to: "id" }] },
    ]);
  });
});

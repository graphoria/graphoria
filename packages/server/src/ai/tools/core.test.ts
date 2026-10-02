process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

import type { BunRequest } from "bun";
import type { SchemaEntities } from "../../configuration/getSchemas";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { RoleEntities } from "./core";

const { env } = await import("../../singletons/env");
const { handleGraphQLRequestFactory } =
  await import("../../configuration/gql/handleGraphQLRequestFactory");
const { executeGraphqlCore, makeValidateQuery } = await import("./core");

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

describe("makeValidateQuery — cost limit", () => {
  let previous: number;

  beforeAll(() => {
    previous = env.maxQueryCost;
    env.maxQueryCost = 10_000;
  });

  afterAll(() => {
    env.maxQueryCost = previous;
  });

  describe("delegating to the role's own validator", () => {
    const validateQuery = makeValidateQuery(role);

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
    const validateQuery = makeValidateQuery(role, 20);

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
    const validateQuery = makeValidateQuery(role);

    const outcome = await executeGraphqlCore(
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
      recorded,
      makeValidateQuery(recorded),
      { query: "{ users { id } }" },
      { session, req },
    );

    expect(calls[0]![2]).toBe(req);
    expect(calls[0]![3]).toBe(session);
  });

  it("stands in a request when the caller brings none", async () => {
    const { calls, role: recorded } = recording();

    await executeGraphqlCore(
      recorded,
      makeValidateQuery(recorded),
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

    const outcome = await executeGraphqlCore(role, makeValidateQuery(role), { query }, {});

    expect(outcome).toEqual({
      kind: "error",
      message: "`ask` cannot run inside a tool call: it would start the agent again.",
    });
    expect(queries).toEqual([]);
  });

  it("runs a query selecting a column named ask", async () => {
    const { queries, role } = recording();

    const outcome = await executeGraphqlCore(
      role,
      makeValidateQuery(role),
      { query: "{ notes { ask } }" },
      {},
    );

    expect(outcome.kind).toBe("ok");
    expect(queries).toHaveLength(1);
  });
});

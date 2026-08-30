process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

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

// oxlint-disable-next-line typescript/no-explicit-any
const entities = { getResolverSource: () => undefined } as any;
const gqlEntities = { typeDefs: sdl, schema, introspection: introspectionFromSchema(schema) };

const role = {
  schema,
  handlers: { gql: handleGraphQLRequestFactory(entities, gqlEntities) },
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

    const outcome = await executeGraphqlCore(role, validateQuery, {
      query: PAGINATED,
      variables: { n: 1000 },
    });

    expect(outcome.kind).toBe("validation");
  });
});

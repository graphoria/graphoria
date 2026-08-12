import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { buildSchema, introspectionFromSchema } from "graphql";

import type { BunRequest } from "bun";
import type { AnalysisResult } from "../../analyzeQuery/types";
import type { Auth } from "../../types/configuration";

import { EntitySource } from "../../types/resolver";

// `singletons/env` parses process.env at module load. Set required vars
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

// oxlint-disable-next-line typescript/no-explicit-any
let factoryFn: any;
// oxlint-disable-next-line typescript/no-explicit-any
let analyzeQueryModule: any;

const sdl = `
  type Query {
    users: [User!]!
    auth_me: AuthMe
    remote_query_field: String
  }
  type Mutation {
    queue_publish(data: String): String
    auth_login(username: String!, password: String!): LoginResult
    remote_mutation_field: String
  }
  type User {
    id: ID!
    name: String!
    posts: [Post!]!
  }
  type Post {
    id: ID!
    title: String!
    comments: [Comment!]!
  }
  type Comment {
    id: ID!
    body: String!
    replies: [Comment!]!
  }
  type AuthMe {
    username: String
    role: String
  }
  type LoginResult {
    access_token: String!
    expires_in: Int!
    role: String
  }
`;

const schema = buildSchema(sdl);
const introspection = introspectionFromSchema(schema);

const sourceMap: Record<string, EntitySource> = {
  users: EntitySource.TABLE,
  auth_me: EntitySource.AUTH,
  remote_query_field: EntitySource.REMOTE_SCHEMA,
  queue_publish: EntitySource.QUEUE_PUBLISHER,
  auth_login: EntitySource.AUTH,
  remote_mutation_field: EntitySource.REMOTE_SCHEMA,
};

const buildEntities = ({
  withQueuePublisher = true,
  withRemoteMutation = true,
}: { withQueuePublisher?: boolean; withRemoteMutation?: boolean } = {}) =>
  ({
    getResolverSource: (name: string) => sourceMap[name],
    queuesMap: withQueuePublisher
      ? { queue_publish: { resolverName: "queue_publish_resolver" } }
      : {},
    remoteQueriesMap: {
      remote_query_field: {
        remoteSchema: { name: "remote-q" },
        originalFieldName: "originalQ",
      },
    },
    remoteMutationsMap: withRemoteMutation
      ? {
          remote_mutation_field: {
            remoteSchema: { name: "remote-m" },
            originalFieldName: "originalM",
          },
        }
      : {},
    queriesMap: {},
    mutationsMap: {},
    operations: {},
    // oxlint-disable-next-line typescript/no-explicit-any
  }) as any;

const gqlEntities = { typeDefs: sdl, schema, introspection };

const fakeReq = {} as unknown as BunRequest;

beforeAll(async () => {
  ({ handleGraphQLRequestFactory: factoryFn } = await import("./handleGraphQLRequestFactory"));
  analyzeQueryModule = await import("../../analyzeQuery");
});

describe("handleGraphQLRequestFactory — pure helpers", () => {
  it("isIntrospectionQuery detects __schema queries", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    expect(factory.isIntrospectionQuery("query { __schema { queryType { name } } }")).toBe(true);
    expect(factory.isIntrospectionQuery("query { users { id } }")).toBe(false);
  });

  it("isNoDataQuery detects _no_data sentinel", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    expect(factory.isNoDataQuery("query { _no_data }")).toBe(true);
    expect(factory.isNoDataQuery("query { users { id } }")).toBe(false);
  });

  it("introspectionResult passes through gqlEntities.introspection", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    expect(factory.introspectionResult).toEqual({ data: introspection });
  });

  it("noDataResult returns the no-data sentinel", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    expect(factory.noDataResult).toEqual({
      data: { _no_data: "No data available" },
    });
  });
});

describe("handleGraphQLRequestFactory.hasErrors", () => {
  it("returns hasErrors=false for a valid query", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const result = factory.hasErrors("query { users { id name } }");
    expect(result.hasErrors).toBe(false);
    expect(result.validationErrors).toHaveLength(0);
  });

  it("returns a validation error for an unknown field", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const result = factory.hasErrors("query { not_a_field }");
    expect(result.hasErrors).toBe(true);
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.validationErrors[0].message).toContain("not_a_field");
    expect(result.validationErrors[0].locations?.length ?? 0).toBeGreaterThan(0);
  });

  // The depth-limit branch (MAX_QUERY_DEPTH > 0 vs 0) is not asserted here:
  // singletons/env is parsed once per process and Bun's test runner reuses
  // the module cache across test files, so MAX_QUERY_DEPTH gets pinned by
  // whichever file imports env first. The factory's depth wiring is a
  // single-line `env.maxQueryDepth > 0 ? [...specifiedRules, depthLimitRule(N)]
  // : undefined`; the rule itself is exhaustively covered in
  // analyzeQuery/depthLimit.test.ts.
});

describe("handleGraphQLRequestFactory.handler — short-circuits", () => {
  it("returns empty data when there are no operations", async () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const empty: AnalysisResult = { operations: [], fragments: [] };
    expect(await factory.handler(empty, {}, fakeReq, undefined)).toEqual({
      data: {},
    });
  });

  it("auth_me query returns username/role for authenticated session", async () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const analysis: AnalysisResult = {
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [{ name: "auth_me", source: EntitySource.AUTH }],
        },
      ],
      fragments: [],
    };
    const result = await factory.handler(analysis, {}, fakeReq, {
      sub: "alice",
      role: "user",
    });
    expect(result).toEqual({
      data: { auth_me: { username: "alice", role: "user" } },
    });
  });

  it("auth_me query returns null when no session sub", async () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const analysis: AnalysisResult = {
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [{ name: "auth_me", source: EntitySource.AUTH }],
        },
      ],
      fragments: [],
    };
    const result = await factory.handler(analysis, {}, fakeReq, undefined);
    expect(result).toEqual({ data: { auth_me: null } });
  });

  it("auth_me query honours field aliases", async () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const analysis: AnalysisResult = {
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [{ name: "auth_me", alias: "me", source: EntitySource.AUTH }],
        },
      ],
      fragments: [],
    };
    const result = await factory.handler(analysis, {}, fakeReq, {
      sub: "bob",
      role: "admin",
    });
    expect(result).toEqual({
      data: { me: { username: "bob", role: "admin" } },
    });
  });

  it("query path with only auth_me (no table fields) does not error", async () => {
    // The factory short-circuits before SQL generation when there are zero
    // table fields, so this exercises the auth-only code path without needing
    // to mock the SQL pipeline.
    const factory = factoryFn(buildEntities(), gqlEntities);
    const analysis: AnalysisResult = {
      operations: [
        {
          name: null,
          operation: "query",
          variables: [],
          fields: [{ name: "auth_me", source: EntitySource.AUTH }],
        },
      ],
      fragments: [],
    };
    const result = await factory.handler(analysis, {}, fakeReq, {
      sub: "x",
      role: "user",
    });
    expect(result.data).toEqual({ auth_me: { username: "x", role: "user" } });
  });
});

describe("handleGraphQLRequestFactory — query cache", () => {
  // Same call order as the /graphql POST route and buildExecute
  // oxlint-disable-next-line typescript/no-explicit-any
  const routeSequence = async (factory: any, query: string) => {
    factory.isIntrospectionQuery(query);
    factory.isNoDataQuery(query);
    factory.hasErrors(query);
    return factory.handler(query, {}, fakeReq, { sub: "alice", role: "user" });
  };

  it("analyzes a repeated query only once across full route sequences", async () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const query = "query { auth_me { username role } }";
    const spy = spyOn(analyzeQueryModule, "analyzeQuery");
    try {
      const first = await routeSequence(factory, query);
      const second = await routeSequence(factory, query);
      expect(second).toEqual(first);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the cached validation result on repeated hasErrors calls", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const query = "query { users { id } }";
    const first = factory.hasErrors(query);
    const second = factory.hasErrors(query);
    expect(second.validationErrors).toBe(first.validationErrors);
  });

  it("handler returns empty data for an unparseable query string", async () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    expect(await factory.handler("query {", {}, fakeReq, undefined)).toEqual({ data: {} });
  });

  it("hasErrors still throws a syntax error for an unparseable query", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    expect(() => factory.hasErrors("query {")).toThrow("Syntax Error");
  });
});

describe("handleGraphQLRequestFactory.handler — mutation dispatch errors", () => {
  const mutationAnalysis = (field: {
    name: string;
    source: EntitySource;
    arguments?: Record<string, unknown>;
  }): AnalysisResult => ({
    operations: [
      {
        name: null,
        operation: "mutation",
        variables: [],
        fields: [field],
      },
    ],
    fragments: [],
  });

  it("QUEUE_PUBLISHER throws when the publisher is not in queuesMap", () => {
    const factory = factoryFn(buildEntities({ withQueuePublisher: false }), gqlEntities);
    const analysis = mutationAnalysis({
      name: "queue_publish",
      source: EntitySource.QUEUE_PUBLISHER,
      arguments: { data: "$payload" },
    });
    expect(factory.handler(analysis, { payload: "x" }, fakeReq, undefined)).rejects.toThrow(
      "Queue publisher not found",
    );
  });

  it("AUTH auth_login throws when auth.enabled is false", () => {
    const factory = factoryFn(buildEntities(), gqlEntities, {
      enabled: false,
    } as Auth);
    const analysis = mutationAnalysis({
      name: "auth_login",
      source: EntitySource.AUTH,
      arguments: { username: "alice", password: "pw" },
    });
    expect(factory.handler(analysis, {}, fakeReq, undefined)).rejects.toThrow(
      "Authentication is not enabled",
    );
  });

  it("AUTH auth_login throws when auth is null (default)", () => {
    const factory = factoryFn(buildEntities(), gqlEntities);
    const analysis = mutationAnalysis({
      name: "auth_login",
      source: EntitySource.AUTH,
      arguments: { username: "alice", password: "pw" },
    });
    expect(factory.handler(analysis, {}, fakeReq, undefined)).rejects.toThrow(
      "Authentication is not enabled",
    );
  });

  it("REMOTE_SCHEMA mutation throws when the entry is missing from remoteMutationsMap", () => {
    const factory = factoryFn(buildEntities({ withRemoteMutation: false }), gqlEntities);
    const analysis = mutationAnalysis({
      name: "remote_mutation_field",
      source: EntitySource.REMOTE_SCHEMA,
    });
    expect(factory.handler(analysis, {}, fakeReq, undefined)).rejects.toThrow(
      "Remote schema mutation not found",
    );
  });
});

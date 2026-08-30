import { describe, expect, it } from "bun:test";
import { buildSchema, parse } from "graphql";

import { checkQueryCost, estimateQueryCost } from "./costLimit";

const schema = buildSchema(`
  type Query {
    tasks(limit: Int, where: String, orderBy: String): [Task!]!
    tasks_single(where: String): Task
    viewer: Viewer!
  }

  type Task {
    id: ID!
    title: String!
    status: String!
    priority: Int!
    dueDate: String
    createdAt: String!
    updatedAt: String!
    project: Project!
    comments(limit: Int): [Comment!]!
  }

  type Project {
    id: ID!
    name: String!
  }

  type Comment {
    id: ID!
    body: String!
  }

  type Viewer {
    task: Task!
  }
`);

const pageLimits = { defaultPageSize: 100, maxPageSize: 1000 };

const cost = (query: string, variables: Record<string, unknown> = {}) =>
  estimateQueryCost(parse(query), schema, variables, pageLimits);

describe("estimateQueryCost", () => {
  it("counts a selection of scalars without multiplying anything", () => {
    expect(cost(`{ viewer { task { id title } } }`)).toBe(4);
  });

  it("charges an unbounded list the default page size", () => {
    expect(cost(`{ tasks { id } }`)).toBe(101);
  });

  it("charges a list its literal limit", () => {
    expect(cost(`{ tasks(limit: 20) { id title project { id name } } }`)).toBe(101);
  });

  it("charges a list the runtime value of its limit variable", () => {
    expect(cost(`query ($n: Int) { tasks(limit: $n) { id } }`, { n: 5 })).toBe(6);
  });

  it("falls back to the default page size when the limit variable has no value", () => {
    expect(cost(`query ($n: Int) { tasks(limit: $n) { id } }`)).toBe(101);
  });

  it("multiplies nested lists rather than adding them", () => {
    expect(cost(`{ tasks { id comments { id } } }`)).toBe(10201);
  });

  it("counts the fan-out inside a fragment spread", () => {
    const spread = `
      query { tasks { ...Explosion } }
      fragment Explosion on Task { comments { id } }
    `;

    expect(cost(spread)).toBe(cost(`{ tasks { comments { id } } }`));
    expect(cost(spread)).toBe(10101);
  });

  it("counts the fan-out inside an inline fragment", () => {
    expect(cost(`{ tasks { ... on Task { comments { id } } } }`)).toBe(10101);
  });

  it("terminates on a circular fragment", () => {
    const circular = `
      query { tasks { ...A } }
      fragment A on Task { id ...B }
      fragment B on Task { title ...A }
    `;

    expect(cost(circular)).toBe(201);
  });

  it("skips introspection meta-fields", () => {
    expect(cost(`{ __typename tasks { id __typename } }`)).toBe(101);
  });

  it("charges a to-one relationship and a single-row field a multiplier of one", () => {
    expect(cost(`{ tasks_single { id title project { id name } } }`)).toBe(6);
  });

  it("reports the most expensive operation in the document", () => {
    const document = `
      query Cheap { tasks(limit: 1) { id } }
      query Expensive { tasks { id comments { id } } }
    `;

    expect(cost(document)).toBe(10201);
  });
});

describe("checkQueryCost", () => {
  const check = (query: string, maxCost: number, variables: Record<string, unknown> = {}) =>
    checkQueryCost(parse(query), schema, variables, pageLimits, maxCost);

  it("passes a query within the budget", () => {
    expect(check(`{ tasks { id } }`, 100_000)).toBeNull();
  });

  it("passes a realistic dashboard query at the recommended budget", () => {
    const dashboard = `
      query Dashboard {
        tasks(where: "open", orderBy: "dueDate") {
          id
          title
          status
          priority
          dueDate
          createdAt
          updatedAt
        }
      }
    `;

    expect(estimateQueryCost(parse(dashboard), schema, {}, pageLimits)).toBe(701);
    expect(check(dashboard, 100_000)).toBeNull();
  });

  it("rejects a query over the budget, naming the estimate and the cap", () => {
    const error = check(`query Wide { tasks { id comments { id } } }`, 10_000);

    expect(error?.message).toBe(
      `Estimated query cost of 10201 exceeds the maximum allowed cost of 10000 (operation: "Wide"). Raise MAX_QUERY_COST to allow more expensive queries.`,
    );
  });

  it("names an unnamed operation as anonymous", () => {
    expect(check(`{ tasks { id comments { id } } }`, 10_000)?.message).toContain(
      `(operation: "anonymous")`,
    );
  });

  it("names the operation the estimate came from, not merely the first", () => {
    const document = `
      query Cheap { tasks(limit: 1) { id } }
      query Expensive { tasks { id comments { id } } }
    `;

    expect(check(document, 10_000)?.message).toContain(`(operation: "Expensive")`);
  });

  it("rejects the query the variable value makes expensive", () => {
    const query = `query ($n: Int) { tasks(limit: $n) { id comments { id } } }`;

    expect(check(query, 10_000, { n: 1 })).toBeNull();
    expect(check(query, 10_000, { n: 1000 })).not.toBeNull();
  });
});

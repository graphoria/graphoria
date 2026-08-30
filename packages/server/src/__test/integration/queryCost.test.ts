import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { IntegrationContext, StartedServer } from "./harness";

import { fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * The budget is engine-agnostic — the estimate is drawn from the document and
 * the schema, and never reaches the query builder — so one engine proves it.
 *
 * Set on the env singleton rather than through `startServer`'s `env` override:
 * that override reaches `createGraphQLServer`'s own copy, and the GraphQL
 * request factory reads the singleton. The budget is read per call, so setting
 * it after boot is enough.
 */

const MAX_QUERY_COST = 100_000;

const organizationsField = fieldName("pg", "app", "organizations");
const projectsField = fieldName("pg", "app", "projects");
const tasksField = fieldName("pg", "app", "tasks");

const WIDE = `
  query Wide {
    rows: ${organizationsField} {
      id
      ${projectsField} {
        id
        ${tasksField} { id title notes priority estimate_hours due_at completed }
      }
    }
  }
`;

describe.skipIf(!integrationEnabled)("integration query cost", () => {
  let started: StartedServer;
  let gql: IntegrationContext["gql"];
  // oxlint-disable-next-line typescript/no-explicit-any
  let env: any;
  let previous: number;

  beforeAll(async () => {
    started = await startServer({ engine: "pg" });
    gql = started.context.gql;

    ({ env } = await import("../../singletons/env"));
    previous = env.maxQueryCost;
    env.maxQueryCost = MAX_QUERY_COST;
  });

  afterAll(async () => {
    env.maxQueryCost = previous;
    await started?.stop();
  });

  it("answers a realistic query without touching it", async () => {
    const response = await gql(`
      query Dashboard {
        rows: ${tasksField}(limit: 25, orderBy: [{ id: ASC }]) { id title priority completed }
      }
    `);

    expect(response.errors ?? []).toEqual([]);
  });

  it("rejects a wide query, naming the estimate and the cap", async () => {
    const response = await gql(WIDE);

    expect(response.errors?.[0]?.message).toContain(
      `exceeds the maximum allowed cost of ${MAX_QUERY_COST}`,
    );
  });

  it("counts a fan-out moved into a fragment", async () => {
    const response = await gql(`
      query Hidden {
        rows: ${organizationsField} { id ...Explosion }
      }
      fragment Explosion on ${organizationsField} {
        ${projectsField} {
          id
          ${tasksField} { id title notes priority estimate_hours due_at completed }
        }
      }
    `);

    expect(response.errors?.[0]?.message).toContain("exceeds the maximum allowed cost");
  });

  it("charges the query the variables it was sent with, not the one before it", async () => {
    const query = `
      query Paged($n: Int) {
        rows: ${projectsField}(limit: $n) {
          id
          ${tasksField} { id title notes priority estimate_hours due_at completed }
        }
      }
    `;

    expect((await gql(query, { n: 1 })).errors ?? []).toEqual([]);
    expect((await gql(query, { n: 500 })).errors?.[0]?.message).toContain(
      "exceeds the maximum allowed cost",
    );
  });
});

describe.skipIf(!integrationEnabled)("integration query cost, as shipped", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer({ engine: "pg" });
  });

  afterAll(async () => {
    await started?.stop();
  });

  // Asserted so that turning the budget on by default fails a test rather than
  // silently rejecting queries every existing deployment answers today.
  it("is off when no budget is configured", async () => {
    expect((await started.context.gql(WIDE)).errors ?? []).toEqual([]);
  });
});

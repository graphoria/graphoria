import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";

const SCRAPE_SECRET = "scrape-me";

const metricsEnv = {
  metrics: {
    enabled: true,
    endpoint: "/metrics",
    secrets: [SCRAPE_SECRET],
    maxOperationLabels: 200,
  },
};

describe.skipIf(!integrationEnabled)("metrics endpoint", () => {
  let started: StartedServer;

  const scrape = (headers: Record<string, string> = {}) =>
    Bun.fetch(`http://localhost:${started.context.server.port}/metrics`, { headers });

  beforeAll(async () => {
    started = await startServer({ engine: "pg", env: metricsEnv });
  });

  afterAll(async () => {
    await started?.stop();
  });

  it("refuses a scrape carrying no secret", async () => {
    expect((await scrape()).status).toBe(401);
  });

  it("refuses a scrape carrying the wrong secret", async () => {
    expect((await scrape({ "x-admin-secret": "nope" })).status).toBe(401);
  });

  it("serves the exposition to the scoped secret", async () => {
    const response = await scrape({ "x-admin-secret": SCRAPE_SECRET });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("counts a GraphQL operation, its HTTP request and their durations", async () => {
    await started.context.gql(
      `query MetricsProbe { ${fieldName("pg", "app", "tags")} { id } }`,
      {},
      { admin: true },
    );

    const body = await (await scrape({ "x-admin-secret": SCRAPE_SECRET })).text();

    expect(body).toContain(
      'graphoria_graphql_operations_total{operation="MetricsProbe",outcome="success",role="superadmin",type="query"} 1',
    );
    expect(body).toContain(
      'graphoria_graphql_operation_duration_seconds_count{operation="MetricsProbe",role="superadmin",type="query"} 1',
    );
    expect(body).toContain(
      'graphoria_http_requests_total{method="POST",route="graphql",status="200"} 1',
    );
    expect(body).toContain(
      'graphoria_http_request_duration_seconds_count{method="POST",route="graphql"}',
    );
  });

  it("counts a REST request under the rest route", async () => {
    await started.context.rest("/nothing-here", { admin: true });

    const body = await (await scrape({ "x-admin-secret": SCRAPE_SECRET })).text();

    expect(body).toContain('route="rest"');
  });

  it("counts a rejected query as a rejection and not as an operation", async () => {
    await started.context.gql("query Bogus { not_a_field }", {}, { admin: true });

    const body = await (await scrape({ "x-admin-secret": SCRAPE_SECRET })).text();

    expect(body).toContain('graphoria_graphql_rejections_total{reason="validation"}');
    expect(body).not.toContain('operation="Bogus"');
  });

  it("does not count the scrape itself", async () => {
    const body = await (await scrape({ "x-admin-secret": SCRAPE_SECRET })).text();

    expect(body).not.toContain('route="metrics"');
  });

  it("serves the exposition to the admin secret too", async () => {
    const response = await scrape({ "x-admin-secret": process.env["ADMIN_SECRET"]! });

    expect(response.status).toBe(200);
  });
});

describe.skipIf(!integrationEnabled)("metrics endpoint while disabled", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer({ engine: "pg", skipSeed: true });
  });

  afterAll(async () => {
    await started?.stop();
  });

  it("does not mount the route at all", async () => {
    const response = await Bun.fetch(`http://localhost:${started.context.server.port}/metrics`, {
      headers: { "x-admin-secret": process.env["ADMIN_SECRET"]! },
    });

    expect(response.status).toBe(404);
  });
});

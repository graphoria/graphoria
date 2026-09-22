import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

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

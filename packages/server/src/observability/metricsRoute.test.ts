import { describe, expect, it } from "bun:test";

import type { CapabilityGrant } from "../authentication/capabilities";

import { createMetricsRoute } from "./metricsRoute";

const request = (secret?: string) =>
  new Request("http://localhost/metrics", {
    headers: secret ? { "x-admin-secret": secret } : {},
  });

const routeFor = (grantFor: string | null, body = "# HELP x y\n") =>
  createMetricsRoute({
    path: "/metrics",
    secretHeader: "x-admin-secret",
    authorize: (candidate): CapabilityGrant | null =>
      candidate !== null && candidate === grantFor ? { superset: false } : null,
    render: () => body,
  });

describe("createMetricsRoute", () => {
  it("mounts a GET handler on the configured path", () => {
    expect(Object.keys(routeFor("s3cret"))).toEqual(["/metrics"]);
  });

  it("refuses a scrape carrying no secret", async () => {
    const response = await routeFor("s3cret")["/metrics"]!.GET(request());

    expect(response.status).toBe(401);
  });

  it("refuses a scrape carrying the wrong secret", async () => {
    const response = await routeFor("s3cret")["/metrics"]!.GET(request("wrong"));

    expect(response.status).toBe(401);
  });

  it("serves the exposition in the Prometheus text format", async () => {
    const response = await routeFor("s3cret", "metric 1\n")["/metrics"]!.GET(request("s3cret"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await response.text()).toBe("metric 1\n");
  });

  it("renders at scrape time, not at mount time", async () => {
    let renders = 0;
    const route = createMetricsRoute({
      path: "/metrics",
      secretHeader: "x-admin-secret",
      authorize: () => ({ superset: false }),
      render: () => {
        renders++;
        return "";
      },
    });

    expect(renders).toBe(0);
    await route["/metrics"]!.GET(request("any"));
    expect(renders).toBe(1);
  });
});

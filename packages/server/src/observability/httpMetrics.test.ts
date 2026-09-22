import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { configureMetrics, createRegistry, setMetricsRegistry } from "./metrics";
import { withHttpMetrics } from "./httpMetrics";

const request = (method = "POST") => new Request("http://localhost/graphql", { method });

describe("withHttpMetrics", () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
    setMetricsRegistry(registry);
    configureMetrics({ enabled: true });
  });

  afterEach(() => {
    setMetricsRegistry(null);
    configureMetrics({ enabled: false });
  });

  it("passes the response through untouched", async () => {
    const response = new Response("body", { status: 201 });
    const wrapped = withHttpMetrics("graphql", () => response);

    expect(await wrapped(request())).toBe(response);
  });

  it("counts a request by route, method and status", async () => {
    await withHttpMetrics("graphql", () => new Response(null, { status: 200 }))(request());

    expect(registry.render()).toContain(
      'graphoria_http_requests_total{method="POST",route="graphql",status="200"} 1',
    );
  });

  it("times every request", async () => {
    await withHttpMetrics("rest", () => new Response(null))(request("GET"));

    expect(registry.render()).toContain(
      'graphoria_http_request_duration_seconds_count{method="GET",route="rest"} 1',
    );
  });

  it("counts a thrown handler as the 500 the server answers with, and rethrows", async () => {
    const wrapped = withHttpMetrics("rest", () => {
      throw new Error("boom");
    });

    await expect(wrapped(request())).rejects.toThrow("boom");
    expect(registry.render()).toContain(
      'graphoria_http_requests_total{method="POST",route="rest",status="500"} 1',
    );
  });

  it("records nothing when the handler upgrades the connection instead of answering", async () => {
    const wrapped = withHttpMetrics("graphql", () => undefined);

    expect(await wrapped(request("GET"))).toBeUndefined();
    expect(registry.render()).toBe("");
  });

  it("awaits an async handler before recording its status", async () => {
    await withHttpMetrics("rest", async () => {
      await Bun.sleep(1);
      return new Response(null, { status: 404 });
    })(request());

    expect(registry.render()).toContain('status="404"');
  });
});

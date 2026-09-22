import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { configureTracing, createTracer, formatTraceparent, setTracer } from "./tracing";
import { withHttpTracing } from "./httpTracing";

type RenderedSpan = {
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
};

const OFF = {
  enabled: false,
  endpoint: "http://collector:4318",
  headers: "",
  serviceName: "graphoria",
  sampleRatio: 1,
};

const request = (method = "POST", headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/graphql?token=secret", { method, headers });

describe("withHttpTracing", () => {
  const sent: string[] = [];
  let tracer: ReturnType<typeof createTracer>;

  const spans = async (): Promise<RenderedSpan[]> => {
    await tracer.flush();
    return sent.flatMap((body) =>
      (
        JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: RenderedSpan[] }[] }[] }
      ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
    );
  };

  const attribute = (span: RenderedSpan, key: string) =>
    span.attributes.find((entry) => entry.key === key)?.value;

  beforeEach(() => {
    sent.length = 0;
    tracer = createTracer({
      endpoint: "http://collector:4318",
      serviceName: "graphoria",
      serviceVersion: "1.2.3",
      exportIntervalMs: 0,
      send: async (_url, init) => {
        sent.push(init.body);
      },
    });
    setTracer(tracer);
    configureTracing({ ...OFF, enabled: true });
  });

  afterEach(() => {
    setTracer(null);
    configureTracing(OFF);
  });

  it("passes the response through untouched", async () => {
    const response = new Response("body", { status: 201 });

    expect(await withHttpTracing("graphql", () => response)(request())).toBe(response);
  });

  it("names the span for the method and the route, never the URL", async () => {
    await withHttpTracing("graphql", () => new Response(null))(request());

    const [span] = await spans();

    expect(span!.name).toBe("POST graphql");
    expect(span!.kind).toBe(2);
    expect(JSON.stringify(span)).not.toContain("secret");
  });

  it("carries the method, route, scheme, host and status", async () => {
    await withHttpTracing("rest", () => new Response(null, { status: 404 }))(request("GET"));

    const [span] = await spans();

    expect(attribute(span!, "http.request.method")).toEqual({ stringValue: "GET" });
    expect(attribute(span!, "http.route")).toEqual({ stringValue: "rest" });
    expect(attribute(span!, "url.scheme")).toEqual({ stringValue: "http" });
    expect(attribute(span!, "server.address")).toEqual({ stringValue: "localhost:3000" });
    expect(attribute(span!, "http.response.status_code")).toEqual({ intValue: "404" });
  });

  it("continues an inbound traceparent", async () => {
    const caller = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };

    await withHttpTracing(
      "graphql",
      () => new Response(null),
    )(request("POST", { traceparent: formatTraceparent(caller) }));

    const [span] = await spans();

    expect(span!.traceId).toBe(caller.traceId);
    expect(span!.parentSpanId).toBe(caller.spanId);
  });

  it("starts a fresh trace when the inbound traceparent is malformed", async () => {
    await withHttpTracing(
      "graphql",
      () => new Response(null),
    )(request("POST", { traceparent: "not-a-header" }));

    const [span] = await spans();

    expect(span!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span!.parentSpanId).toBeUndefined();
  });

  it("marks a throwing handler's span errored and rethrows", async () => {
    const wrapped = withHttpTracing("rest", () => {
      throw new Error("boom");
    });

    await expect(wrapped(request())).rejects.toThrow("boom");

    const [span] = await spans();

    expect(span!.status).toEqual({ code: 2, message: "boom" });
  });

  it("records no span when the handler upgrades the connection instead of answering", async () => {
    expect(await withHttpTracing("graphql", () => undefined)(request("GET"))).toBeUndefined();

    expect(await spans()).toHaveLength(0);
  });

  it("records nothing while tracing is disabled", async () => {
    configureTracing(OFF);

    const response = new Response(null);

    expect(await withHttpTracing("graphql", () => response)(request())).toBe(response);
    expect(await spans()).toHaveLength(0);
  });
});

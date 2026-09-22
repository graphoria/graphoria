import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { flushSpans, formatTraceparent } from "../../observability/tracing";
import { fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";

/** The `otel-collector` service in docker-compose.test.yml. */
const COLLECTOR_URL = "http://localhost:54318/v1/traces";

/** A value that must never appear on a span, anywhere. */
const SENTINEL = "ana@acme.test";

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
};

const spansIn = (body: string): Span[] =>
  (
    JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }
  ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));

const stringAttribute = (span: Span, key: string) =>
  (
    span.attributes.find((entry) => entry.key === key)?.value as
      | { stringValue?: string }
      | undefined
  )?.stringValue;

describe.skipIf(!integrationEnabled)("tracing", () => {
  let started: StartedServer;
  let sink: ReturnType<typeof Bun.serve>;
  const bodies: string[] = [];

  const exported = async () => {
    await flushSpans();
    return bodies.flatMap(spansIn);
  };

  beforeAll(async () => {
    sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.text());
        return new Response("{}", { status: 200 });
      },
    });

    started = await startServer({
      engine: "pg",
      env: {
        tracing: {
          enabled: true,
          endpoint: `http://localhost:${sink.port}`,
          headers: "",
          serviceName: "graphoria",
          sampleRatio: 1,
        },
      },
    });
  });

  afterAll(async () => {
    await started?.stop();
    await sink?.stop(true);
  });

  const probe = (headers: Record<string, string> = {}) =>
    started.context.gql(
      `query TraceProbe { ${fieldName("pg", "app", "users")}(where: { email: { eq: "${SENTINEL}" } }) { id } }`,
      {},
      { admin: true, headers },
    );

  it("produces one connected trace from the request down to the database", async () => {
    bodies.length = 0;

    const response = await probe();
    expect(response.errors).toBeUndefined();

    const spans = await exported();

    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);

    const http = spans.find((span) => span.name === "POST graphql")!;
    const operation = spans.find((span) => span.name === "query TraceProbe")!;
    const analyze = spans.find((span) => span.name === "graphoria.analyze")!;
    const statement = spans.find((span) => span.name === "db.query")!;

    expect(http.parentSpanId).toBeUndefined();
    expect(operation.parentSpanId).toBe(http.spanId);
    expect(analyze.parentSpanId).toBe(http.spanId);
    expect(statement.parentSpanId).toBe(operation.spanId);

    // Every parent resolves inside the same batch, which is what "connected" means.
    const ids = new Set(spans.map((span) => span.spanId));
    for (const span of spans) {
      if (span.parentSpanId) expect(ids.has(span.parentSpanId)).toBe(true);
    }
  });

  it("carries the operation, the role and the statement, and no variable values", async () => {
    bodies.length = 0;

    await probe();

    const spans = await exported();
    const operation = spans.find((span) => span.name === "query TraceProbe")!;
    const statement = spans.find((span) => span.name === "db.query")!;

    expect(stringAttribute(operation, "graphql.operation.name")).toBe("TraceProbe");
    expect(stringAttribute(operation, "graphql.operation.type")).toBe("query");
    expect(stringAttribute(operation, "graphoria.role")).toBe("superadmin");
    expect(stringAttribute(statement, "db.system")).toBe("pg");
    expect(stringAttribute(statement, "db.statement")).toContain("SELECT");

    // The literal was hoisted into a bound parameter, so it is nowhere in the
    // exported payload — not in the statement, not on any other span.
    expect(JSON.stringify(spans)).not.toContain(SENTINEL);
  });

  it("continues an inbound traceparent", async () => {
    bodies.length = 0;

    const caller = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };
    await probe({ traceparent: formatTraceparent(caller) });

    const spans = await exported();
    const http = spans.find((span) => span.name === "POST graphql")!;

    expect(http.traceId).toBe(caller.traceId);
    expect(http.parentSpanId).toBe(caller.spanId);
  });

  it("is accepted by a real OTLP collector, which rejects a malformed payload", async () => {
    bodies.length = 0;

    await probe();
    await flushSpans();

    // The collector is distroless and carries no healthcheck, so the first post
    // is retried until its receiver is listening.
    const post = async (body: string) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          return await Bun.fetch(COLLECTOR_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await Bun.sleep(250);
        }
      }
    };

    expect(bodies.length).toBeGreaterThan(0);
    expect((await post(bodies[0]!)).status).toBe(200);
    expect((await post(`{"resourceSpans":"not-an-array"}`)).status).toBe(400);
  });
});

describe.skipIf(!integrationEnabled)("tracing while disabled", () => {
  let started: StartedServer;
  let sink: ReturnType<typeof Bun.serve>;
  const bodies: string[] = [];

  beforeAll(async () => {
    sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.text());
        return new Response("{}", { status: 200 });
      },
    });

    // The endpoint is pointed at a live sink on purpose: the silence has to come
    // from the gate, not from having nowhere to post.
    started = await startServer({
      engine: "pg",
      env: {
        tracing: {
          enabled: false,
          endpoint: `http://localhost:${sink.port}`,
          headers: "",
          serviceName: "graphoria",
          sampleRatio: 1,
        },
      },
    });
  });

  afterAll(async () => {
    await started?.stop();
    await sink?.stop(true);
  });

  it("exports nothing", async () => {
    const response = await started.context.gql(
      `query Quiet { ${fieldName("pg", "app", "users")} { id } }`,
      {},
      { admin: true },
    );
    expect(response.errors).toBeUndefined();

    await flushSpans();

    expect(bodies).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it } from "bun:test";

import type { Tracer } from "./tracing";

import {
  activeSpanContext,
  configureTracing,
  createTracer,
  formatTraceparent,
  parseTraceparent,
  setTracer,
  startSpan,
  withActiveSpan,
  withSpan,
} from "./tracing";

type Sent = { url: string; headers: Record<string, string>; body: string };

/** A span as it appears in the OTLP payload, which is the only shape a collector sees. */
type RenderedSpan = {
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

const collect = () => {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: init.body });
    },
  };
};

const tracerWith = (overrides: Partial<Parameters<typeof createTracer>[0]> = {}) => {
  const sink = collect();
  const warnings: Record<string, unknown>[] = [];
  const tracer = createTracer({
    endpoint: "http://collector:4318",
    serviceName: "graphoria",
    serviceVersion: "1.2.3",
    exportIntervalMs: 0,
    send: sink.send,
    log: { warn: (record: unknown) => warnings.push(record as Record<string, unknown>) } as never,
    ...overrides,
  });
  return { tracer, sent: sink.sent, warnings };
};

const spansOf = (body: string): RenderedSpan[] => {
  const payload = JSON.parse(body) as {
    resourceSpans: { scopeSpans: { spans: RenderedSpan[] }[] }[];
  };
  return payload.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
};

const exported = async (tracer: Tracer, sent: Sent[]) => {
  await tracer.flush();
  return sent.flatMap((entry) => spansOf(entry.body));
};

describe("identifiers", () => {
  it("mints a 32 hex character trace id and a 16 hex character span id", async () => {
    const { tracer, sent } = tracerWith();
    tracer.startSpan("root").end();

    const [span] = await exported(tracer, sent);

    expect(span!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("never mints an all-zero identifier", async () => {
    const { tracer, sent } = tracerWith();
    for (let index = 0; index < 50; index++) tracer.startSpan("root").end();

    const spans = await exported(tracer, sent);

    expect(spans).toHaveLength(50);
    for (const span of spans) {
      expect(span.traceId).not.toBe("0".repeat(32));
      expect(span.spanId).not.toBe("0".repeat(16));
    }
  });

  it("mints a distinct trace id per root", async () => {
    const { tracer, sent } = tracerWith();
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();

    const [first, second] = await exported(tracer, sent);

    expect(first!.traceId).not.toBe(second!.traceId);
  });
});

describe("traceparent", () => {
  it("round-trips a formatted header", () => {
    const context = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };

    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });

  it("formats the sampled flag as 01 and an unsampled one as 00", () => {
    const base = { traceId: "a".repeat(32), spanId: "b".repeat(16) };

    expect(formatTraceparent({ ...base, sampled: true })).toBe(
      `00-${base.traceId}-${base.spanId}-01`,
    );
    expect(formatTraceparent({ ...base, sampled: false })).toBe(
      `00-${base.traceId}-${base.spanId}-00`,
    );
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["an unsupported version", `01-${"a".repeat(32)}-${"b".repeat(16)}-01`],
    ["a short trace id", `00-${"a".repeat(31)}-${"b".repeat(16)}-01`],
    ["a short span id", `00-${"a".repeat(32)}-${"b".repeat(15)}-01`],
    ["non-hex characters", `00-${"z".repeat(32)}-${"b".repeat(16)}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${"b".repeat(16)}-01`],
    ["an all-zero span id", `00-${"a".repeat(32)}-${"0".repeat(16)}-01`],
    ["trailing junk", `00-${"a".repeat(32)}-${"b".repeat(16)}-01-extra`],
  ])("ignores %s without throwing", (_label, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });
});

describe("parenting", () => {
  it("gives a child the parent's trace id and span id", async () => {
    const { tracer, sent } = tracerWith();

    await tracer.withSpan("parent", {}, async () => {
      tracer.startSpan("child").end();
    });

    const spans = await exported(tracer, sent);
    const parent = spans.find((span) => span.name === "parent")!;
    const child = spans.find((span) => span.name === "child")!;

    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it("leaves a root without a parent span id", async () => {
    const { tracer, sent } = tracerWith();
    tracer.startSpan("root").end();

    const [span] = await exported(tracer, sent);

    expect(span!.parentSpanId).toBeUndefined();
  });

  it("continues an explicitly supplied parent context", async () => {
    const { tracer, sent } = tracerWith();
    const parent = { traceId: "c".repeat(32), spanId: "d".repeat(16), sampled: true };

    tracer.startSpan("child", { parent }).end();

    const [span] = await exported(tracer, sent);

    expect(span!.traceId).toBe(parent.traceId);
    expect(span!.parentSpanId).toBe(parent.spanId);
  });

  it("exposes the active context only inside withSpan", async () => {
    const { tracer } = tracerWith();

    expect(tracer.active()).toBeUndefined();

    const inside = await tracer.withSpan("root", {}, () => tracer.active());

    expect(inside).toBeDefined();
    expect(tracer.active()).toBeUndefined();
  });
});

describe("withSpan", () => {
  it("ends the span and returns what the body returned", async () => {
    const { tracer, sent } = tracerWith();

    const result = await tracer.withSpan("root", {}, () => "value");

    expect(result).toBe("value");
    expect(await exported(tracer, sent)).toHaveLength(1);
  });

  it("marks a throwing body's span errored, ends it, and rethrows", async () => {
    const { tracer, sent } = tracerWith();

    await expect(
      tracer.withSpan("root", {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const [span] = await exported(tracer, sent);

    expect(span!.status).toEqual({ code: 2, message: "boom" });
  });

  it("puts the supplied attributes on the span", async () => {
    const { tracer, sent } = tracerWith();

    await tracer.withSpan("root", { attributes: { "db.name": "app" } }, () => undefined);

    const [span] = await exported(tracer, sent);

    expect(span!.attributes).toEqual([{ key: "db.name", value: { stringValue: "app" } }]);
  });
});

describe("sampling", () => {
  it("records nothing at ratio 0", async () => {
    const { tracer, sent } = tracerWith({ sampleRatio: 0 });
    tracer.startSpan("root").end();

    expect(await exported(tracer, sent)).toHaveLength(0);
  });

  it("records everything at ratio 1", async () => {
    const { tracer, sent } = tracerWith({ sampleRatio: 1 });
    tracer.startSpan("root").end();

    expect(await exported(tracer, sent)).toHaveLength(1);
  });

  it("lets an unsampled parent override a local ratio of 1", async () => {
    const { tracer, sent } = tracerWith({ sampleRatio: 1 });
    const parent = { traceId: "c".repeat(32), spanId: "d".repeat(16), sampled: false };

    tracer.startSpan("child", { parent }).end();

    expect(await exported(tracer, sent)).toHaveLength(0);
  });

  it("lets a sampled parent override a local ratio of 0", async () => {
    const { tracer, sent } = tracerWith({ sampleRatio: 0 });
    const parent = { traceId: "c".repeat(32), spanId: "d".repeat(16), sampled: true };

    tracer.startSpan("child", { parent }).end();

    expect(await exported(tracer, sent)).toHaveLength(1);
  });

  it("decides once at the root, so a child never re-samples", async () => {
    const { tracer, sent } = tracerWith({ sampleRatio: 0 });
    const parent = { traceId: "c".repeat(32), spanId: "d".repeat(16), sampled: true };

    await tracer.withSpan("parent", { parent }, async () => {
      tracer.startSpan("child").end();
    });

    expect(await exported(tracer, sent)).toHaveLength(2);
  });
});

describe("OTLP payload", () => {
  it("posts to the traces path on the configured endpoint", async () => {
    const { tracer, sent } = tracerWith();
    tracer.startSpan("root").end();
    await tracer.flush();

    expect(sent[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
  });

  it("sends the configured extra headers", async () => {
    const { tracer, sent } = tracerWith({ headers: "api-key=abc, tenant=acme" });
    tracer.startSpan("root").end();
    await tracer.flush();

    expect(sent[0]!.headers["api-key"]).toBe("abc");
    expect(sent[0]!.headers["tenant"]).toBe("acme");
  });

  it("carries the service name and version on the resource", async () => {
    const { tracer, sent } = tracerWith();
    tracer.startSpan("root").end();
    await tracer.flush();

    const payload = JSON.parse(sent[0]!.body) as {
      resourceSpans: { resource: { attributes: { key: string; value: unknown }[] } }[];
    };

    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "graphoria" } },
      { key: "service.version", value: { stringValue: "1.2.3" } },
    ]);
  });

  it("renders timestamps as decimal nanosecond strings", async () => {
    const { tracer, sent } = tracerWith();
    const span = tracer.startSpan("root");
    span.end();
    await tracer.flush();

    const [rendered] = spansOf(sent[0]!.body);

    expect(rendered!.startTimeUnixNano).toMatch(/^\d+$/);
    expect(rendered!.endTimeUnixNano).toMatch(/^\d+$/);
    expect(BigInt(rendered!.endTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(rendered!.startTimeUnixNano),
    );
    // Nanoseconds since the epoch, not since the process started.
    expect(BigInt(rendered!.startTimeUnixNano)).toBeGreaterThan(1_700_000_000_000_000_000n);
  });

  it("renders the kind and the status as the OTLP numeric enums", async () => {
    const { tracer, sent } = tracerWith();
    tracer.startSpan("client", { kind: "client" }).end();
    const errored = tracer.startSpan("server", { kind: "server" });
    errored.setStatus("error", "boom");
    errored.end();
    await tracer.flush();

    const spans = spansOf(sent[0]!.body);

    expect(spans.find((span) => span.name === "client")!.kind).toBe(3);
    expect(spans.find((span) => span.name === "server")!.kind).toBe(2);
    expect(spans.find((span) => span.name === "server")!.status).toEqual({
      code: 2,
      message: "boom",
    });
  });

  it("types each attribute value by its JavaScript type", async () => {
    const { tracer, sent } = tracerWith();
    const span = tracer.startSpan("root");
    span.setAttribute("text", "value");
    span.setAttribute("count", 7);
    span.setAttribute("ratio", 1.5);
    span.setAttribute("flag", true);
    span.setAttribute("missing", undefined);
    span.end();
    await tracer.flush();

    const [rendered] = spansOf(sent[0]!.body);

    expect(rendered!.attributes).toEqual([
      { key: "text", value: { stringValue: "value" } },
      { key: "count", value: { intValue: "7" } },
      { key: "ratio", value: { doubleValue: 1.5 } },
      { key: "flag", value: { boolValue: true } },
    ]);
  });

  it("records an error as an errored status carrying the message", async () => {
    const { tracer, sent } = tracerWith();
    const span = tracer.startSpan("root");
    span.recordError(new Error("exploded"));
    span.end();

    const [rendered] = await exported(tracer, sent);

    expect(rendered!.status).toEqual({ code: 2, message: "exploded" });
  });
});

describe("batching", () => {
  it("holds spans until the batch fills", async () => {
    const { tracer, sent } = tracerWith({ maxBatch: 4 });
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();

    expect(sent).toHaveLength(0);

    await tracer.flush();

    expect(sent).toHaveLength(1);
  });

  it("posts as soon as the batch is full, without waiting for a flush", async () => {
    const { tracer, sent } = tracerWith({ maxBatch: 2 });
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();

    await Bun.sleep(1);

    expect(sent).toHaveLength(1);
    expect(spansOf(sent[0]!.body)).toHaveLength(2);
  });

  it("posts nothing when there is nothing queued", async () => {
    const { tracer, sent } = tracerWith();

    await tracer.flush();

    expect(sent).toHaveLength(0);
  });

  it("drops the oldest spans past the queue ceiling", async () => {
    const { tracer, sent, warnings } = tracerWith({ maxBatch: 1000, maxQueue: 3 });
    for (const name of ["a", "b", "c", "d", "e"]) tracer.startSpan(name).end();

    const spans = await exported(tracer, sent);

    expect(spans.map((span) => span.name)).toEqual(["c", "d", "e"]);
    expect(warnings).toEqual([{ dropped: 2 }]);
  });

  it("survives a rejected export and does not re-send the batch", async () => {
    let attempts = 0;
    const { tracer, warnings } = tracerWith({
      send: async () => {
        attempts += 1;
        throw new Error("collector down");
      },
    });
    tracer.startSpan("a").end();

    await tracer.flush();
    await tracer.flush();

    expect(attempts).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});

describe("the process tracer", () => {
  afterEach(() => {
    setTracer(null);
    configureTracing({
      enabled: false,
      endpoint: "http://localhost:4318",
      headers: "",
      serviceName: "graphoria",
      sampleRatio: 1,
    });
  });

  it("returns no span and enters no context while disabled", async () => {
    const { tracer, sent } = tracerWith();
    setTracer(tracer);

    expect(startSpan("root")).toBeUndefined();
    expect(activeSpanContext()).toBeUndefined();

    const result = await withSpan("root", {}, (span) => {
      expect(span).toBeUndefined();
      expect(activeSpanContext()).toBeUndefined();
      return "returned";
    });

    expect(result).toBe("returned");
    expect(await exported(tracer, sent)).toHaveLength(0);
  });

  it("exports nothing for a span that is entered but never ended", async () => {
    const { tracer, sent } = tracerWith();
    setTracer(tracer);
    configureTracing({
      enabled: true,
      endpoint: "http://collector:4318",
      headers: "",
      serviceName: "graphoria",
      sampleRatio: 1,
    });

    const seen = withActiveSpan(startSpan("root"), () => activeSpanContext());

    expect(seen).toBeDefined();
    expect(await exported(tracer, sent)).toHaveLength(0);
  });

  it("runs the body outside any context when there is no span", () => {
    expect(withActiveSpan(undefined, () => activeSpanContext())).toBeUndefined();
  });

  it("records through the installed tracer once enabled", async () => {
    const { tracer, sent } = tracerWith();
    setTracer(tracer);
    configureTracing({
      enabled: true,
      endpoint: "http://collector:4318",
      headers: "",
      serviceName: "graphoria",
      sampleRatio: 1,
    });

    await withSpan("root", {}, () => {
      startSpan("child")?.end();
      return activeSpanContext();
    });

    const spans = await exported(tracer, sent);

    expect(spans.map((span) => span.name).sort()).toEqual(["child", "root"]);
  });
});

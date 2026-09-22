import { afterEach, describe, expect, it } from "bun:test";

import { configureTracing, createTracer, setTracer, startSpan, withSpan } from "./tracing";

const ITERATIONS = 20_000;

const OFF = {
  enabled: false,
  endpoint: "http://collector:4318",
  headers: "",
  serviceName: "graphoria",
  sampleRatio: 1,
};

/** executor.ts's own attribute helper, in the shape its call site builds. */
const sourceAttributes = (source: { operation: { name: string; type: string }; role: string }) => ({
  "graphql.operation.name": source.operation.name,
  "graphql.operation.type": source.operation.type,
  "graphoria.role": source.role,
});

const STATEMENT = "SELECT id FROM app.users WHERE email = $1 LIMIT $2";

const perCallNs = (run: () => void) => {
  for (let i = 0; i < 1000; i++) run();
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) run();
  return (Bun.nanoseconds() - start) / ITERATIONS;
};

/**
 * Bounds, not benchmarks, on the same terms as metrics.perf.test.ts. Measured on
 * the machine these were written on: ~80ns per call site disabled, ~3µs to start
 * and end a span, ~3µs through the async context. Each bound sits several times
 * above that so a shared CI runner does not turn it red, which is also the limit
 * of what it catches: a regression of roughly an order of magnitude — a
 * serialization per span, sync I/O, an unbounded scan — rather than a small one.
 * The claim being defended is that share: a database round trip is 1–50ms, so a
 * span alongside it has to stay in the microseconds.
 */
describe("tracing overhead", () => {
  afterEach(() => {
    setTracer(null);
    configureTracing(OFF);
  });

  const install = (enabled: boolean) => {
    setTracer(
      createTracer({
        endpoint: "http://collector:4318",
        serviceName: "graphoria",
        serviceVersion: "test",
        exportIntervalMs: 0,
        // The production batch size, so the measurement carries a realistic
        // share of the serialization each span eventually pays for.
        maxBatch: 512,
        send: async () => undefined,
      }),
    );
    configureTracing({ ...OFF, enabled });
  };

  // The shape every call site uses, copied from executor.ts: the attributes are
  // the caller's expression, so they are built before startSpan can consult the
  // gate. That, not the gate check alone, is what a disabled process pays per
  // span site. Measuring startSpan(name) with no options instead measures
  // nothing: the optimizer drops an allocation whose only consumer returned
  // undefined, and the number that comes back is the dead-code elimination.
  it("costs under 500ns per call while disabled, at the shape a call site uses", () => {
    install(false);

    const source = { operation: { name: "TraceProbe", type: "query" }, role: "user" };
    const cost = perCallNs(() => {
      startSpan("db.query", {
        kind: "client",
        attributes: {
          "db.system": "pg",
          "db.name": "app",
          "db.statement": STATEMENT,
          ...sourceAttributes(source),
        },
      });
    });

    expect(cost).toBeLessThan(500);
  });

  it("costs under 20 microseconds to start and end a span while enabled", () => {
    install(true);

    const cost = perCallNs(() => {
      startSpan("db.query", {
        kind: "client",
        attributes: { "db.system": "pg", "db.name": "app", "db.statement": "SELECT 1" },
      })?.end();
    });

    expect(cost).toBeLessThan(20_000);
  });

  it("costs under 20 microseconds to enter and leave the async context", async () => {
    install(true);

    const run = () => withSpan("query Probe", {}, () => undefined);

    for (let i = 0; i < 500; i++) await run();
    const start = Bun.nanoseconds();
    for (let i = 0; i < 5_000; i++) await run();

    expect((Bun.nanoseconds() - start) / 5_000).toBeLessThan(20_000);
  });

  it("holds the queue at its ceiling however many spans arrive", async () => {
    const posted: number[] = [];
    const tracer = createTracer({
      endpoint: "http://collector:4318",
      serviceName: "graphoria",
      serviceVersion: "test",
      exportIntervalMs: 0,
      maxBatch: 100_000,
      maxQueue: 256,
      log: { warn: () => undefined } as never,
      send: async (_url, init) => {
        posted.push(
          (JSON.parse(init.body) as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] })
            .resourceSpans[0]!.scopeSpans[0]!.spans.length,
        );
      },
    });

    for (let i = 0; i < 50_000; i++) tracer.startSpan("db.query").end();
    await tracer.flush();

    expect(posted).toEqual([256]);
  });
});

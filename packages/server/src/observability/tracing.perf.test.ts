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

const perCallNs = (run: () => void) => {
  for (let i = 0; i < 1000; i++) run();
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) run();
  return (Bun.nanoseconds() - start) / ITERATIONS;
};

/**
 * Bounds, not benchmarks, on the same terms as metrics.perf.test.ts. Measured on
 * the machine these were written on: ~13ns per call disabled, ~2.8µs to start
 * and end a span, ~2.3µs through the async context. Each bound sits several
 * times above that so a shared CI runner does not turn it red, which is also
 * the limit of what it catches: a regression of roughly an order of magnitude —
 * a serialization per span, sync I/O, an unbounded scan — rather than a small
 * one. The claim being defended is that share: a database round trip is 1–50ms,
 * so a span alongside it has to stay in the microseconds.
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

  it("costs under 500ns per call while disabled", () => {
    install(false);

    expect(perCallNs(() => startSpan("db.query"))).toBeLessThan(500);
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

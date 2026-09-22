import { afterEach, describe, expect, it } from "bun:test";

import { configureMetrics, createRegistry, incMetric, observeMetric } from "./metrics";
import { withHttpMetrics } from "./httpMetrics";

const ITERATIONS = 50_000;

const perCallNs = (run: () => void) => {
  for (let i = 0; i < 1000; i++) run();
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) run();
  return (Bun.nanoseconds() - start) / ITERATIONS;
};

/**
 * Bounds, not benchmarks. Measured on the machine these were written on: ~30ns
 * per call disabled, 70ns for a counter and 134ns for a histogram when on. Each
 * bound sits about an order of magnitude above that so a shared CI runner does
 * not turn it red, which is also the limit of what it catches: a regression of
 * roughly 20x — a render or a sort per call, sync I/O, an unbounded scan —
 * rather than a small one. A JSON round trip per observation costs ~300ns and
 * stays green, which was measured rather than assumed. The claim being defended
 * is the order of magnitude: recording must stay far below the 1–50ms a
 * database round trip costs, so instrumentation never shows up in a request. A database round trip is 1–50ms, so the budget for the whole
 * instrumentation of a request is microseconds.
 */
describe("metrics overhead", () => {
  afterEach(() => {
    configureMetrics({ enabled: false });
  });

  it("costs under 500ns per call while disabled", () => {
    configureMetrics({ enabled: false });

    const counter = perCallNs(() =>
      incMetric("graphoria_graphql_rejections_total", { reason: "depth" }),
    );
    const histogram = perCallNs(() =>
      observeMetric(
        "graphoria_graphql_operation_duration_seconds",
        { operation: "A", type: "query", role: "user" },
        0.01,
      ),
    );

    expect(counter).toBeLessThan(500);
    expect(histogram).toBeLessThan(500);
  });

  it("costs under 3 microseconds per recorded observation while enabled", () => {
    configureMetrics({ enabled: true });

    const counter = perCallNs(() =>
      incMetric("graphoria_graphql_rejections_total", { reason: "depth" }),
    );
    const histogram = perCallNs(() =>
      observeMetric(
        "graphoria_graphql_operation_duration_seconds",
        { operation: "A", type: "query", role: "user" },
        0.01,
      ),
    );

    expect(counter).toBeLessThan(3_000);
    expect(histogram).toBeLessThan(3_000);
  });

  it("adds under 10 microseconds to a request through the HTTP wrapper", async () => {
    configureMetrics({ enabled: true });
    const wrapped = withHttpMetrics("graphql", () => new Response(null));
    const request = new Request("http://localhost/graphql", { method: "POST" });

    for (let i = 0; i < 500; i++) await wrapped(request);
    const start = Bun.nanoseconds();
    for (let i = 0; i < 5_000; i++) await wrapped(request);

    expect((Bun.nanoseconds() - start) / 5_000).toBeLessThan(10_000);
  });

  it("holds the series count at the cap however many operation names arrive", () => {
    const registry = createRegistry({ maxOperationLabels: 200 });

    for (let i = 0; i < 10_000; i++) {
      registry.inc("graphoria_graphql_operations_total", {
        operation: `op_${i}`,
        type: "query",
        role: "user",
        outcome: "success",
      });
    }

    const series = registry
      .render()
      .split("\n")
      .filter((line) => line.startsWith("graphoria_graphql_operations_total{"));

    expect(series).toHaveLength(201);
  });
});

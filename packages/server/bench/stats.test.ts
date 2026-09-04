import { describe, expect, it } from "bun:test";

import { summarize } from "./stats";

describe("summarize", () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1);

  it("takes percentiles by nearest rank, so every result is a sample that happened", () => {
    const summary = summarize(samples);

    expect(summary.p50).toBe(50);
    expect(summary.p95).toBe(95);
    expect(summary.p99).toBe(99);
  });

  it("reports count, min, max and mean", () => {
    const summary = summarize(samples);

    expect(summary.count).toBe(100);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(100);
    expect(summary.mean).toBeCloseTo(50.5, 10);
  });

  it("derives throughput from the time the samples actually took", () => {
    const summary = summarize([10, 10, 10, 10]);

    // 4 operations over 40ms of measured work.
    expect(summary.throughputPerSecond).toBeCloseTo(100, 10);
  });

  it("does not care what order the samples arrive in", () => {
    const shuffled = [...samples].reverse();

    expect(summarize(shuffled)).toEqual(summarize(samples));
  });

  it("collapses to the one value when there is a single sample", () => {
    const summary = summarize([7]);

    expect(summary).toMatchObject({ count: 1, min: 7, max: 7, mean: 7, p50: 7, p95: 7, p99: 7 });
  });

  it("throws rather than reporting a percentile of nothing", () => {
    expect(() => summarize([])).toThrow("no samples");
  });
});

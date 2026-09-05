import { describe, expect, it } from "bun:test";

import type { BenchReport } from "./compare";

import { compareReports } from "./compare";

const report = (scenarios: Record<string, number>, engine = "pg"): BenchReport => ({
  engine,
  scenarios: Object.entries(scenarios).map(([name, p95]) => ({ name, p95 })),
});

describe("compareReports", () => {
  it("passes when the two runs measured the same latencies", () => {
    const baseline = report({ list: 0.72, aggregate: 26.74 });

    const result = compareReports(baseline, report({ list: 0.72, aggregate: 26.74 }));

    expect(result.ok).toBe(true);
    expect(result.scenarios.every((scenario) => !scenario.regressed)).toBe(true);
  });

  it("trips on a scenario whose p95 is inflated past both bounds", () => {
    const result = compareReports(report({ aggregate: 26.74 }), report({ aggregate: 80.0 }));

    expect(result.ok).toBe(false);
    expect(result.scenarios[0]).toMatchObject({
      name: "aggregate",
      baselineP95: 26.74,
      candidateP95: 80.0,
      regressed: true,
    });
    expect(result.scenarios[0]?.ratio).toBeCloseTo(2.99, 2);
    expect(result.scenarios[0]?.deltaMs).toBeCloseTo(53.26, 2);
  });

  it("does not trip when the ratio is exceeded but the absolute move is under the floor", () => {
    const result = compareReports(report({ list: 0.4 }), report({ list: 0.9 }));

    expect(result.ok).toBe(true);
    expect(result.scenarios[0]?.regressed).toBe(false);
  });

  it("does not trip when the absolute move clears the floor but the ratio does not", () => {
    const result = compareReports(report({ aggregate: 20 }), report({ aggregate: 21.5 }));

    expect(result.ok).toBe(true);
    expect(result.scenarios[0]?.regressed).toBe(false);
  });

  it("reports a scenario present in only one run as added or removed, never as a regression", () => {
    const result = compareReports(
      report({ list: 0.72, dropped: 5 }),
      report({ list: 0.72, "filtered-aggregate": 900 }),
    );

    expect(result.added).toEqual(["filtered-aggregate"]);
    expect(result.removed).toEqual(["dropped"]);
    expect(result.scenarios.map((scenario) => scenario.name)).toEqual(["list"]);
    expect(result.ok).toBe(true);
  });

  it("throws rather than comparing two engines to each other", () => {
    expect(() => compareReports(report({ list: 0.72 }), report({ list: 5 }, "mysql"))).toThrow(
      "different engines",
    );
  });

  it("takes the ratio and the floor from the caller when given", () => {
    const result = compareReports(report({ list: 1 }), report({ list: 2 }), {
      ratio: 1.5,
      floorMs: 0.5,
    });

    expect(result.ok).toBe(false);
  });
});

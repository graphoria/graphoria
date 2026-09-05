/**
 * The regression gate's arithmetic, kept free of I/O and `Bun.argv` so it is
 * unit-testable. `gate.ts` is the CLI around it.
 *
 * The gate compares two runs of the same benchmark on the same machine rather
 * than a run against a committed baseline: hardware cancels out of a same-runner
 * A/B, and no baseline file can go stale.
 */

/** The part of a `bench/results/<engine>.json` report the gate reads. */
export type BenchReport = {
  engine: string;
  scenarios: { name: string; p95: number }[];
};

export type Verdict = {
  name: string;
  baselineP95: number;
  candidateP95: number;
  deltaMs: number;
  ratio: number;
  regressed: boolean;
};

export type Comparison = {
  ok: boolean;
  scenarios: Verdict[];
  added: string[];
  removed: string[];
};

export type Thresholds = { ratio: number; floorMs: number };

/**
 * A bare ratio flaps on the four sub-millisecond scenarios, so a regression has
 * to clear both bounds. The blind spot that buys: a uniform +0.8ms across every
 * scenario is a real regression this gate will not see.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { ratio: 1.5, floorMs: 1 };

export const compareReports = (
  baseline: BenchReport,
  candidate: BenchReport,
  options: Partial<Thresholds> = {},
): Comparison => {
  if (baseline.engine !== candidate.engine) {
    throw new Error(
      `cannot compare different engines: baseline is ${baseline.engine}, candidate is ${candidate.engine}`,
    );
  }

  const { ratio: ratioLimit, floorMs } = { ...DEFAULT_THRESHOLDS, ...options };

  const baselineP95 = new Map(baseline.scenarios.map((scenario) => [scenario.name, scenario.p95]));
  const candidateP95 = new Map(
    candidate.scenarios.map((scenario) => [scenario.name, scenario.p95]),
  );

  const scenarios = candidate.scenarios.flatMap<Verdict>((scenario) => {
    const before = baselineP95.get(scenario.name);
    if (before === undefined) return [];

    const deltaMs = scenario.p95 - before;
    const ratio = scenario.p95 / before;

    return [
      {
        name: scenario.name,
        baselineP95: before,
        candidateP95: scenario.p95,
        deltaMs,
        ratio,
        regressed: ratio > ratioLimit && deltaMs > floorMs,
      },
    ];
  });

  return {
    ok: scenarios.every((verdict) => !verdict.regressed),
    scenarios,
    // A scenario on one side only is a change to the suite, not a regression —
    // which is what keeps the gate green on the run that adds one.
    added: candidate.scenarios
      .filter((scenario) => !baselineP95.has(scenario.name))
      .map((scenario) => scenario.name),
    removed: baseline.scenarios
      .filter((scenario) => !candidateP95.has(scenario.name))
      .map((scenario) => scenario.name),
  };
};

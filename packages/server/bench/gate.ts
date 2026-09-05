import { appendFile } from "node:fs/promises";

import type { BenchReport, Comparison } from "./compare";

import { DEFAULT_THRESHOLDS, compareReports } from "./compare";

/**
 * `bun run bench:compare` — reads two benchmark reports and exits non-zero if
 * any scenario's p95 regressed.
 *
 *   bun run bench:compare -- --baseline=base/pg.json --candidate=head/pg.json
 *   bun run bench:compare -- --baseline=… --candidate=… --ratio=2 --floor-ms=0.5
 *
 * Both reports are expected to come from the same machine; see compare.ts.
 */

const flag = (name: string) =>
  Bun.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];

const required = (name: string) => {
  const value = flag(name);
  if (!value) throw new Error(`--${name}=<path to a bench report> is required`);
  return value;
};

const read = async (path: string) => (await Bun.file(path).json()) as BenchReport;

const ms = (value: number) => value.toFixed(2);
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

const renderTable = (comparison: Comparison, thresholds: { ratio: number; floorMs: number }) => {
  const rows = comparison.scenarios
    .map(
      (verdict) =>
        `| \`${verdict.name}\` | ${ms(verdict.baselineP95)} | ${ms(verdict.candidateP95)} | ${signed(verdict.deltaMs)} | ${verdict.ratio.toFixed(2)}× | ${verdict.regressed ? "**REGRESSED**" : "ok"} |`,
    )
    .join("\n");

  const notes = [
    comparison.added.length > 0 ? `Added since the baseline: ${comparison.added.join(", ")}.` : "",
    comparison.removed.length > 0
      ? `Gone since the baseline: ${comparison.removed.join(", ")}.`
      : "",
  ].filter(Boolean);

  return `## Benchmark gate — ${comparison.ok ? "pass" : "REGRESSION"}

A scenario fails only if its p95 is both more than ${thresholds.ratio}× the baseline
and more than ${thresholds.floorMs} ms slower.

| scenario | base p95 ms | head p95 ms | delta ms | ratio | verdict |
| --- | ---: | ---: | ---: | ---: | --- |
${rows}
${notes.length > 0 ? `\n${notes.join(" ")}\n` : ""}`;
};

const main = async () => {
  const thresholds = {
    ratio: Number(flag("ratio") ?? DEFAULT_THRESHOLDS.ratio),
    floorMs: Number(flag("floor-ms") ?? DEFAULT_THRESHOLDS.floorMs),
  };

  const [baseline, candidate] = await Promise.all([
    read(required("baseline")),
    read(required("candidate")),
  ]);

  const comparison = compareReports(baseline, candidate, thresholds);
  const table = renderTable(comparison, thresholds);

  console.log(table);

  const summary = Bun.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, `${table}\n`);

  if (!comparison.ok) process.exit(1);
};

await main();

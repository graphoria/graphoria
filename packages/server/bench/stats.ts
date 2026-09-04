export type Summary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  /** Operations per second at the measured latency, one request at a time. */
  throughputPerSecond: number;
};

/**
 * Nearest rank rather than an interpolated percentile: every number in the
 * report is then a latency that was actually observed, which is what makes a
 * regression traceable back to a single run.
 */
const percentile = (sorted: number[], quantile: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]!;

export const summarize = (samplesMs: number[]): Summary => {
  if (samplesMs.length === 0) throw new Error("cannot summarize: no samples");

  const sorted = [...samplesMs].sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);

  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    throughputPerSecond: (sorted.length * 1000) / total,
  };
};

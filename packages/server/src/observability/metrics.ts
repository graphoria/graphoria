type MetricDefinition = {
  type: "counter" | "histogram";
  help: string;
  /** Declared sorted, so a rendered series lists its labels in a stable order. */
  labelNames: readonly string[];
};

const METRICS = {
  graphoria_graphql_operations_total: {
    type: "counter",
    help: "GraphQL operations executed, by outcome.",
    labelNames: ["operation", "outcome", "role", "type"],
  },
  graphoria_graphql_operation_duration_seconds: {
    type: "histogram",
    help: "Time spent handling a GraphQL operation, in seconds.",
    labelNames: ["operation", "role", "type"],
  },
  graphoria_graphql_rejections_total: {
    type: "counter",
    help: "GraphQL operations rejected before execution.",
    labelNames: ["reason"],
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;

export type Labels = Record<string, string>;

export type Registry = {
  inc(metric: MetricName, labels: Labels, value?: number): void;
  observe(metric: MetricName, labels: Labels, seconds: number): void;
  render(): string;
};

export type RegistryOptions = {
  /** Distinct values the caller-supplied `operation` label may take, per metric. */
  maxOperationLabels?: number;
};

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

const SEPARATOR = "\u0000";

const OVERFLOW_LABEL = "other";

const DEFAULT_MAX_OPERATION_LABELS = 200;

type HistogramSeries = { counts: number[]; sum: number; count: number };

const escapeLabelValue = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

/**
 * A metric store with no dependencies. The `operation` label is the only one a
 * caller controls, so it is the only one capped: past the cap every new name
 * collapses into `other` rather than minting a series the scrape has to carry
 * forever.
 */
export const createRegistry = ({
  maxOperationLabels = DEFAULT_MAX_OPERATION_LABELS,
}: RegistryOptions = {}): Registry => {
  const counters = new Map<MetricName, Map<string, number>>();
  const histograms = new Map<MetricName, Map<string, HistogramSeries>>();
  const knownOperations = new Map<MetricName, Set<string>>();

  const boundOperation = (metric: MetricName, operation: string) => {
    let known = knownOperations.get(metric);
    if (!known) {
      known = new Set();
      knownOperations.set(metric, known);
    }
    if (known.has(operation)) return operation;
    if (known.size >= maxOperationLabels) return OVERFLOW_LABEL;
    known.add(operation);
    return operation;
  };

  const keyOf = (metric: MetricName, labels: Labels) =>
    METRICS[metric].labelNames
      .map((name) => {
        const value = labels[name] ?? "";
        return name === "operation" ? boundOperation(metric, value) : value;
      })
      .join(SEPARATOR);

  const renderLabels = (metric: MetricName, key: string, extra?: string) => {
    const values = key.split(SEPARATOR);
    const pairs = METRICS[metric].labelNames.map(
      (name, index) => `${name}="${escapeLabelValue(values[index] ?? "")}"`,
    );
    if (extra) pairs.push(extra);
    return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
  };

  const seriesOf = <T>(store: Map<MetricName, Map<string, T>>, metric: MetricName) => {
    let series = store.get(metric);
    if (!series) {
      series = new Map();
      store.set(metric, series);
    }
    return series;
  };

  const renderHeader = (lines: string[], metric: MetricName) => {
    const definition = METRICS[metric];
    lines.push(`# HELP ${metric} ${definition.help}`, `# TYPE ${metric} ${definition.type}`);
  };

  return {
    inc: (metric, labels, value = 1) => {
      const series = seriesOf(counters, metric);
      const key = keyOf(metric, labels);
      series.set(key, (series.get(key) ?? 0) + value);
    },

    observe: (metric, labels, seconds) => {
      const series = seriesOf(histograms, metric);
      const key = keyOf(metric, labels);
      let entry = series.get(key);
      if (!entry) {
        entry = { counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
        series.set(key, entry);
      }
      entry.sum += seconds;
      entry.count += 1;
      for (let index = 0; index < BUCKETS.length; index++) {
        if (seconds <= BUCKETS[index]!) entry.counts[index]! += 1;
      }
    },

    render: () => {
      const lines: string[] = [];

      for (const [metric, series] of counters) {
        if (series.size === 0) continue;
        renderHeader(lines, metric);
        for (const [key, value] of series) {
          lines.push(`${metric}${renderLabels(metric, key)} ${value}`);
        }
      }

      for (const [metric, series] of histograms) {
        if (series.size === 0) continue;
        renderHeader(lines, metric);
        for (const [key, entry] of series) {
          for (let index = 0; index < BUCKETS.length; index++) {
            lines.push(
              `${metric}_bucket${renderLabels(metric, key, `le="${BUCKETS[index]}"`)} ${entry.counts[index]}`,
            );
          }
          lines.push(
            `${metric}_bucket${renderLabels(metric, key, 'le="+Inf"')} ${entry.count}`,
            `${metric}_sum${renderLabels(metric, key)} ${entry.sum}`,
            `${metric}_count${renderLabels(metric, key)} ${entry.count}`,
          );
        }
      }

      return lines.length > 0 ? `${lines.join("\n")}\n` : "";
    },
  };
};

/**
 * Off until boot turns it on, so an executor or a handler used outside a booted
 * server records nothing. Every call site goes through the helpers below, whose
 * first act is this check — a disabled process pays one branch and allocates
 * nothing.
 */
let enabled = false;

let options: RegistryOptions = {};

let override: Registry | null = null;
let instance: Registry | null = null;

export const configureMetrics = (settings: { enabled: boolean } & RegistryOptions): void => {
  enabled = settings.enabled;
  options = { maxOperationLabels: settings.maxOperationLabels };
  instance = null;
};

/** Test seam: pass `null` to drop the process registry and its recorded series. */
export const setMetricsRegistry = (registry: Registry | null): void => {
  override = registry;
  instance = null;
};

const registry = (): Registry => {
  if (override) return override;
  if (!instance) instance = createRegistry(options);
  return instance;
};

export const incMetric = (metric: MetricName, labels: Labels, value = 1): void => {
  if (!enabled) return;
  registry().inc(metric, labels, value);
};

export const observeMetric = (metric: MetricName, labels: Labels, seconds: number): void => {
  if (!enabled) return;
  registry().observe(metric, labels, seconds);
};

export const renderMetrics = (): string => registry().render();

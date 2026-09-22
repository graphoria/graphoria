import { afterEach, describe, expect, it } from "bun:test";

import {
  configureMetrics,
  createRegistry,
  incMetric,
  observeMetric,
  renderMetrics,
  setMetricsRegistry,
} from "./metrics";

describe("createRegistry", () => {
  it("renders a counter with its HELP and TYPE lines", () => {
    const registry = createRegistry();

    registry.inc("graphoria_graphql_rejections_total", { reason: "depth" });
    registry.inc("graphoria_graphql_rejections_total", { reason: "depth" });

    expect(registry.render()).toContain(
      "# HELP graphoria_graphql_rejections_total GraphQL operations rejected before execution.",
    );
    expect(registry.render()).toContain("# TYPE graphoria_graphql_rejections_total counter");
    expect(registry.render()).toContain('graphoria_graphql_rejections_total{reason="depth"} 2');
  });

  it("keeps one series per distinct label set", () => {
    const registry = createRegistry();

    registry.inc("graphoria_graphql_rejections_total", { reason: "depth" });
    registry.inc("graphoria_graphql_rejections_total", { reason: "cost" });

    const rendered = registry.render();

    expect(rendered).toContain('graphoria_graphql_rejections_total{reason="depth"} 1');
    expect(rendered).toContain('graphoria_graphql_rejections_total{reason="cost"} 1');
  });

  it("renders nothing for a metric that was never touched", () => {
    expect(createRegistry().render()).not.toContain("graphoria_graphql_rejections_total");
  });
});

describe("histograms", () => {
  const observe = (registry: ReturnType<typeof createRegistry>, seconds: number) =>
    registry.observe(
      "graphoria_graphql_operation_duration_seconds",
      { operation: "RecentOrders", type: "query", role: "user" },
      seconds,
    );

  it("renders cumulative buckets, a sum and a count", () => {
    const registry = createRegistry();

    observe(registry, 0.003);
    observe(registry, 0.4);

    const rendered = registry.render();
    const labels = 'operation="RecentOrders",role="user",type="query"';

    expect(rendered).toContain("# TYPE graphoria_graphql_operation_duration_seconds histogram");
    expect(rendered).toContain(
      `graphoria_graphql_operation_duration_seconds_bucket{${labels},le="0.005"} 1`,
    );
    expect(rendered).toContain(
      `graphoria_graphql_operation_duration_seconds_bucket{${labels},le="0.5"} 2`,
    );
    expect(rendered).toContain(
      `graphoria_graphql_operation_duration_seconds_bucket{${labels},le="+Inf"} 2`,
    );
    expect(rendered).toContain(`graphoria_graphql_operation_duration_seconds_sum{${labels}} 0.403`);
    expect(rendered).toContain(`graphoria_graphql_operation_duration_seconds_count{${labels}} 2`);
  });

  it("counts an observation above every bucket only in +Inf", () => {
    const registry = createRegistry();

    observe(registry, 30);

    const rendered = registry.render();
    const labels = 'operation="RecentOrders",role="user",type="query"';

    expect(rendered).toContain(
      `graphoria_graphql_operation_duration_seconds_bucket{${labels},le="10"} 0`,
    );
    expect(rendered).toContain(
      `graphoria_graphql_operation_duration_seconds_bucket{${labels},le="+Inf"} 1`,
    );
  });
});

describe("label handling", () => {
  it("escapes backslashes, quotes and newlines in a label value", () => {
    const registry = createRegistry();

    registry.inc("graphoria_graphql_operations_total", {
      operation: 'a\\b"c\nd',
      type: "query",
      role: "user",
      outcome: "success",
    });

    expect(registry.render()).toContain('operation="a\\\\b\\"c\\nd"');
  });

  it("caps distinct operation labels and folds the rest into other", () => {
    const registry = createRegistry({ maxOperationLabels: 2 });

    for (const operation of ["A", "B", "C", "D"]) {
      registry.inc("graphoria_graphql_operations_total", {
        operation,
        type: "query",
        role: "user",
        outcome: "success",
      });
    }

    const rendered = registry.render();

    expect(rendered).toContain('operation="A"');
    expect(rendered).toContain('operation="B"');
    expect(rendered).not.toContain('operation="C"');
    expect(rendered).not.toContain('operation="D"');
    expect(rendered).toContain(
      'graphoria_graphql_operations_total{operation="other",outcome="success",role="user",type="query"} 2',
    );
  });

  it("keeps counting an operation it already knows once the cap is reached", () => {
    const registry = createRegistry({ maxOperationLabels: 1 });
    const labels = { type: "query", role: "user", outcome: "success" };

    registry.inc("graphoria_graphql_operations_total", { ...labels, operation: "A" });
    registry.inc("graphoria_graphql_operations_total", { ...labels, operation: "B" });
    registry.inc("graphoria_graphql_operations_total", { ...labels, operation: "A" });

    expect(registry.render()).toContain(
      'graphoria_graphql_operations_total{operation="A",outcome="success",role="user",type="query"} 2',
    );
  });
});

describe("the process registry", () => {
  afterEach(() => {
    setMetricsRegistry(null);
    configureMetrics({ enabled: false });
  });

  it("records nothing while metrics are disabled", () => {
    const registry = createRegistry();
    setMetricsRegistry(registry);
    configureMetrics({ enabled: false });

    incMetric("graphoria_graphql_rejections_total", { reason: "depth" });
    observeMetric("graphoria_graphql_operation_duration_seconds", { operation: "A" }, 1);

    expect(registry.render()).toBe("");
  });

  it("records through the injected registry once enabled", () => {
    const registry = createRegistry();
    setMetricsRegistry(registry);
    configureMetrics({ enabled: true });

    incMetric("graphoria_graphql_rejections_total", { reason: "cost" });

    expect(renderMetrics()).toContain('graphoria_graphql_rejections_total{reason="cost"} 1');
  });

  it("starts from an empty registry when the seam is reset", () => {
    configureMetrics({ enabled: true });
    setMetricsRegistry(createRegistry());
    incMetric("graphoria_graphql_rejections_total", { reason: "cost" });

    setMetricsRegistry(null);

    expect(renderMetrics()).not.toContain("graphoria_graphql_rejections_total");
  });
});

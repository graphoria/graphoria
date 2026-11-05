type Panel = { title: string; expr: string; legend: string; unit: string };

// Every series the server exports, whatever the extras: a panel whose extra is
// off (the queues' without --rabbitmq) shows "No data".
const PANELS: Panel[] = [
  {
    title: "HTTP requests/s",
    expr: "sum by (status) (rate(graphoria_http_requests_total[$__rate_interval]))",
    legend: "{{status}}",
    unit: "reqps",
  },
  {
    title: "HTTP p95",
    expr: "histogram_quantile(0.95, sum by (le, route) (rate(graphoria_http_request_duration_seconds_bucket[$__rate_interval])))",
    legend: "{{route}}",
    unit: "s",
  },
  {
    title: "GraphQL operations/s",
    expr: "sum by (outcome) (rate(graphoria_graphql_operations_total[$__rate_interval]))",
    legend: "{{outcome}}",
    unit: "ops",
  },
  {
    title: "GraphQL p95",
    expr: "histogram_quantile(0.95, sum by (le, operation) (rate(graphoria_graphql_operation_duration_seconds_bucket[$__rate_interval])))",
    legend: "{{operation}}",
    unit: "s",
  },
  {
    title: "GraphQL rejections/s",
    expr: "sum by (reason) (rate(graphoria_graphql_rejections_total[$__rate_interval]))",
    legend: "{{reason}}",
    unit: "ops",
  },
  {
    title: "Rate-limit rejections/s",
    expr: "sum by (role) (rate(graphoria_rate_limit_rejections_total[$__rate_interval]))",
    legend: "{{role}}",
    unit: "reqps",
  },
  // The scaffold's job ticks once a minute, so the cron panels read 5 minutes:
  // a shorter window often holds no tick.
  {
    title: "Cron runs (5 min)",
    expr: "sum by (job, outcome) (increase(graphoria_cron_runs_total[5m]))",
    legend: "{{job}} {{outcome}}",
    unit: "short",
  },
  {
    title: "Cron p95",
    expr: "histogram_quantile(0.95, sum by (le, job) (rate(graphoria_cron_run_duration_seconds_bucket[5m])))",
    legend: "{{job}}",
    unit: "s",
  },
  {
    title: "Queue messages published/s",
    expr: "sum by (publisher, outcome) (rate(graphoria_queue_messages_published_total[$__rate_interval]))",
    legend: "{{publisher}} {{outcome}}",
    unit: "mps",
  },
  {
    title: "Queue messages consumed/s",
    expr: "sum by (consumer, outcome) (rate(graphoria_queue_messages_consumed_total[$__rate_interval]))",
    legend: "{{consumer}} {{outcome}}",
    unit: "mps",
  },
];

// The uid grafana/datasources.yml gives Prometheus.
const DATASOURCE = { type: "prometheus", uid: "prometheus" };

const dashboard = {
  uid: "graphoria",
  title: "Graphoria",
  schemaVersion: 41,
  time: { from: "now-15m", to: "now" },
  refresh: "10s",
  // Two panels a row on Grafana's 24-column grid.
  panels: PANELS.map(({ title, expr, legend, unit }, index) => ({
    id: index + 1,
    type: "timeseries",
    title,
    datasource: DATASOURCE,
    gridPos: { x: (index % 2) * 12, y: Math.floor(index / 2) * 8, w: 12, h: 8 },
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: [{ refId: "A", expr, legendFormat: legend }],
  })),
};

/** grafana/graphoria.json, the home dashboard of the Grafana that --metrics scaffolds. */
export const GRAFANA_DASHBOARD = `${JSON.stringify(dashboard, null, 2)}\n`;

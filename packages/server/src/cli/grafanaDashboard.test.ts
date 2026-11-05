import { describe, expect, it } from "bun:test";

import { METRICS } from "../observability/metrics";
import { GRAFANA_DASHBOARD } from "./grafanaDashboard";

type Dashboard = {
  uid: string;
  title: string;
  panels: {
    datasource: { type: string; uid: string };
    targets: { expr: string; legendFormat: string }[];
  }[];
};

const dashboard = () => JSON.parse(GRAFANA_DASHBOARD) as Dashboard;

// A histogram's _bucket, _sum and _count series read as the histogram itself.
const seriesOnBoard = () =>
  new Set(
    (GRAFANA_DASHBOARD.match(/graphoria_[a-z_]+/g) ?? []).map((name) =>
      name.replace(/_(bucket|sum|count)$/, ""),
    ),
  );

describe("GRAFANA_DASHBOARD", () => {
  it("parses as the Graphoria dashboard", () => {
    expect(dashboard()).toMatchObject({ uid: "graphoria", title: "Graphoria" });
  });

  it("names no series the server does not export", () => {
    const exported = new Set<string>(Object.keys(METRICS));

    expect([...seriesOnBoard()].filter((name) => !exported.has(name))).toEqual([]);
  });

  it("charts every series the server exports", () => {
    const charted = seriesOnBoard();

    expect(Object.keys(METRICS).filter((name) => !charted.has(name))).toEqual([]);
  });

  it("groups and names each series only by labels the server gives it", () => {
    for (const { expr, legendFormat } of dashboard().panels.flatMap(({ targets }) => targets)) {
      const name = expr.match(/graphoria_[a-z_]+/)![0].replace(/_(bucket|sum|count)$/, "");
      const given = new Set<string>([...METRICS[name as keyof typeof METRICS].labelNames, "le"]);
      const used = [...`${expr} ${legendFormat}`.matchAll(/by \(([^)]+)\)|\{\{(\w+)\}\}/g)].flatMap(
        ([, by, legend]) => (by ?? legend!).split(", "),
      );

      expect(used.filter((label) => !given.has(label))).toEqual([]);
    }
  });

  it("reads every panel from the Prometheus datasource", () => {
    for (const panel of dashboard().panels) {
      expect(panel.datasource).toEqual({ type: "prometheus", uid: "prometheus" });
    }
  });
});

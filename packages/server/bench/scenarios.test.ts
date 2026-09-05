import { describe, expect, it } from "bun:test";

import { aggregateQuery, assertProductive, filteredAggregateQuery, scenarios } from "./scenarios";

describe("assertProductive", () => {
  it("accepts a payload whose root field returned rows", () => {
    expect(() => assertProductive("list", { bench_tasks: [{ id: 1 }] })).not.toThrow();
  });

  it("rejects a payload whose root field returned nothing", () => {
    expect(() => assertProductive("list", { bench_tasks: [] })).toThrow(
      "list produced no rows — the benchmark would be measuring an empty result",
    );
  });

  it("accepts a stored routine reporting success", () => {
    expect(() => assertProductive("procedure", { bench_tasks_by_priority: true })).not.toThrow();
  });

  it("rejects a stored routine reporting failure", () => {
    expect(() => assertProductive("procedure", { bench_tasks_by_priority: false })).toThrow(
      "procedure produced no rows",
    );
  });

  it("rejects a payload with no root fields at all", () => {
    expect(() => assertProductive("list", {})).toThrow("list produced no rows");
  });
});

describe("the aggregate pair", () => {
  it("bounds the filtered one with a where clause on the indexed foreign key", () => {
    expect(filteredAggregateQuery("pg")).toContain("where: { project_id: { lt: 500 } }");
  });

  it("leaves the unfiltered one scanning the whole table", () => {
    expect(aggregateQuery("pg")).not.toContain("where:");
  });

  it("computes the same five functions in both, so the two are comparable", () => {
    for (const aggregate of ["count", "min", "max", "sum", "avg"]) {
      expect(aggregateQuery("pg")).toContain(aggregate);
      expect(filteredAggregateQuery("pg")).toContain(aggregate);
    }
  });
});

describe("scenarios", () => {
  it("covers both aggregates alongside the original five workloads", () => {
    expect(scenarios("pg").map((scenario) => scenario.name)).toEqual([
      "list",
      "filtered-list",
      "nested",
      "aggregate",
      "filtered-aggregate",
      "procedure",
      "cached-repeat",
    ]);
  });
});

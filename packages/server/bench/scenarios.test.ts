import { describe, expect, it } from "bun:test";

import { assertProductive } from "./scenarios";

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

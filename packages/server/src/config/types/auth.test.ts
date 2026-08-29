import { describe, expect, it } from "bun:test";

import { FILTER_OPERATORS, FilterConditionZod, RolePermissionZod } from "./auth";

describe("FilterConditionZod", () => {
  it("keeps only the operators the filter actually declared", () => {
    const parsed = FilterConditionZod.parse({ email: { eq: "$session.sub" } }) as Record<
      string,
      Record<string, unknown>
    >;

    // An enum-keyed z.record is exhaustive, so the obvious spelling of this
    // schema materialises every operator key with an `undefined` value. They
    // survive Object.entries and reach buildCondition, which then evaluates
    // operators the role never wrote — `between` throws on its arity check, and
    // the null-check operators would read `undefined` as `false`.
    expect(Object.keys(parsed["email"]!)).toEqual(["eq"]);
  });

  it("rejects an operator that is not implemented", () => {
    expect(() => FilterConditionZod.parse({ email: { nope: 1 } })).toThrow();
  });

  it("accepts every implemented operator", () => {
    for (const operator of FILTER_OPERATORS) {
      const parsed = FilterConditionZod.parse({ col: { [operator]: 1 } }) as Record<
        string,
        Record<string, unknown>
      >;

      expect(Object.keys(parsed["col"]!)).toEqual([operator]);
    }
  });

  it("still accepts a nested relation filter", () => {
    const parsed = FilterConditionZod.parse({
      project: { organization_id: { eq: 1 } },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    expect(Object.keys(parsed["project"]!["organization_id"]!)).toEqual(["eq"]);
  });
});

describe("RolePermissionZod rateLimit", () => {
  it("accepts a per-role ceiling", () => {
    const parsed = RolePermissionZod.parse({ rateLimit: { max: 30 } });

    expect(parsed.rateLimit).toEqual({ max: 30 });
  });

  it("accepts a per-role window", () => {
    const parsed = RolePermissionZod.parse({ rateLimit: { max: 30, windowMs: 5000 } });

    expect(parsed.rateLimit).toEqual({ max: 30, windowMs: 5000 });
  });

  it("keeps 0 as the per-role opt-out", () => {
    expect(RolePermissionZod.parse({ rateLimit: { max: 0 } }).rateLimit).toEqual({ max: 0 });
  });

  it("leaves rateLimit undefined when the role does not declare one", () => {
    expect(RolePermissionZod.parse({}).rateLimit).toBeUndefined();
  });

  it("rejects a negative ceiling", () => {
    expect(() => RolePermissionZod.parse({ rateLimit: { max: -1 } })).toThrow();
  });

  it("rejects a window of zero", () => {
    expect(() => RolePermissionZod.parse({ rateLimit: { max: 1, windowMs: 0 } })).toThrow();
  });

  it("rejects an unknown key inside rateLimit", () => {
    expect(() => RolePermissionZod.parse({ rateLimit: { max: 1, burst: 2 } })).toThrow();
  });
});

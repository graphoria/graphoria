import { describe, expect, it } from "bun:test";

import type { ProcedureResolver } from "../../types/db";

import { orderProcedureArguments } from "./procedure-arguments";

const sp = (...names: string[]) =>
  ({ parameters: names.map((name) => ({ name })) }) as unknown as ProcedureResolver;

describe("orderProcedureArguments", () => {
  it("puts the arguments in signature order", () => {
    expect(orderProcedureArguments(sp("a", "b"), { b: 2, a: 1 }).map((v) => v.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("skips signature parameters the caller left out", () => {
    expect(orderProcedureArguments(sp("a", "b", "c"), { c: 3, a: 1 }).map((v) => v.name)).toEqual([
      "a",
      "c",
    ]);
  });

  // Unnamed parameters are introspected under a synthesized name no caller can
  // match, so the metadata orders nothing and the supplied order stands.
  it("keeps arguments the metadata cannot account for", () => {
    expect(orderProcedureArguments(sp("arg1", "arg2"), { x: 1, y: 2 }).map((v) => v.name)).toEqual([
      "x",
      "y",
    ]);
  });
});

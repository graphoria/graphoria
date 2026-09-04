import { describe, expect, it } from "bun:test";

import { matchesAnySecret, safeCompare } from "./secrets";

describe("safeCompare", () => {
  it("matches equal strings", () => {
    expect(safeCompare("abc", "abc")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(safeCompare("abc", "abd")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    expect(safeCompare("abc", "abcd")).toBe(false);
  });
});

describe("matchesAnySecret", () => {
  it("matches the first secret", () => {
    expect(matchesAnySecret("new", ["new", "old"])).toBe(true);
  });

  it("matches a later secret", () => {
    expect(matchesAnySecret("old", ["new", "old"])).toBe(true);
  });

  it("rejects a candidate no secret equals", () => {
    expect(matchesAnySecret("other", ["new", "old"])).toBe(false);
  });

  it("never matches against an empty set, even with an empty candidate", () => {
    expect(matchesAnySecret("", [])).toBe(false);
    expect(matchesAnySecret("x", [])).toBe(false);
  });

  it("never matches a null or empty candidate", () => {
    expect(matchesAnySecret(null, ["new"])).toBe(false);
    expect(matchesAnySecret("", ["new"])).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";

import { containsPattern, toAuthUserSummary } from "./users";

describe("containsPattern", () => {
  it("wraps the search in % and escapes !, %, _ and [ with !", () => {
    expect(containsPattern("ada")).toBe("%ada%");
    expect(containsPattern("")).toBe("%%");
    expect(containsPattern("50%_a!b[c]")).toBe("%50!%!_a!!b![c]%");
  });
});

describe("toAuthUserSummary", () => {
  it.each([
    [true, true],
    [1, true],
    [false, false],
    [0, false],
    [null, false],
  ])("reads is_active %s as %s", (is_active, isActive) => {
    expect(toAuthUserSummary({ username: "ada", role: "editor", is_active })).toEqual({
      username: "ada",
      role: "editor",
      isActive,
    });
  });
});

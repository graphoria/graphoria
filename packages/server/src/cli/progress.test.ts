import { describe, expect, it } from "bun:test";

import { formatDuration } from "./progress";

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [412.4, "412ms"],
    [999.4, "999ms"],
    [999.6, "1.0s"],
    [4210, "4.2s"],
    [59_940, "59.9s"],
    [59_960, "1m 0s"],
    [72_400, "1m 12s"],
  ])("prints %d ms as %s", (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });
});

import { describe, expect, it } from "bun:test";

import { parseCodegenArgs } from "./codegenArgs";

describe("parseCodegenArgs", () => {
  it("parses no flags", () => {
    expect(parseCodegenArgs([])).toEqual({ config: undefined, out: undefined, types: undefined });
  });

  it("parses --config, -c, --out and --types", () => {
    expect(parseCodegenArgs(["--config", "a.ts", "--out", "gen", "--types", "t.d.ts"])).toEqual({
      config: "a.ts",
      out: "gen",
      types: "t.d.ts",
    });
    expect(parseCodegenArgs(["-c", "a.ts"]).config).toBe("a.ts");
  });

  it("rejects an unknown flag, a missing value and a positional", () => {
    expect(() => parseCodegenArgs(["--nope"])).toThrow();
    expect(() => parseCodegenArgs(["--out"])).toThrow();
    expect(() => parseCodegenArgs(["extra"])).toThrow();
  });
});

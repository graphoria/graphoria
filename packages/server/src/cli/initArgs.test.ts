import { describe, expect, it } from "bun:test";

import { parseInitArgs } from "./initArgs";

describe("parseInitArgs", () => {
  it("prompts, installs and leaves the engine open by default", () => {
    expect(parseInitArgs([])).toEqual({ yes: false, install: true });
  });

  it("takes every default with --yes or -y", () => {
    expect(parseInitArgs(["--yes"]).yes).toBe(true);
    expect(parseInitArgs(["-y"]).yes).toBe(true);
  });

  it("preselects the engine with --database or -d", () => {
    expect(parseInitArgs(["--database", "mysql"]).database).toBe("mysql");
    expect(parseInitArgs(["-d", "mssql"]).database).toBe("mssql");
    expect(parseInitArgs(["--database=pg"]).database).toBe("pg");
  });

  it("skips the install with --no-install", () => {
    expect(parseInitArgs(["--no-install"]).install).toBe(false);
  });

  it("answers the frontend question with --frontend or --no-frontend", () => {
    expect(parseInitArgs(["--frontend"]).frontend).toBe(true);
    expect(parseInitArgs(["--no-frontend"]).frontend).toBe(false);
    expect(parseInitArgs([])).not.toHaveProperty("frontend");
  });

  it("rejects an unknown engine", () => {
    expect(() => parseInitArgs(["--database", "oracle"])).toThrow(
      "--database must be one of pg, mysql, mssql",
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseInitArgs(["--force"])).toThrow();
  });

  it("rejects a positional argument", () => {
    expect(() => parseInitArgs(["my-api"])).toThrow();
  });
});

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
    expect(parseInitArgs(["--database", "sqlite"]).database).toBe("sqlite");
  });

  it("skips the install with --no-install", () => {
    expect(parseInitArgs(["--no-install"]).install).toBe(false);
  });

  it("answers the frontend question with --frontend or --no-frontend", () => {
    expect(parseInitArgs(["--frontend"]).frontend).toBe(true);
    expect(parseInitArgs(["--no-frontend"]).frontend).toBe(false);
    expect(parseInitArgs([])).not.toHaveProperty("frontend");
  });

  it("answers the RabbitMQ and AI questions with --rabbitmq/--no-rabbitmq and --ai/--no-ai", () => {
    expect(parseInitArgs(["--rabbitmq"]).rabbitmq).toBe(true);
    expect(parseInitArgs(["--no-rabbitmq"]).rabbitmq).toBe(false);
    expect(parseInitArgs(["--ai"]).ai).toBe(true);
    expect(parseInitArgs(["--no-ai"]).ai).toBe(false);
    expect(parseInitArgs([])).not.toHaveProperty("rabbitmq");
    expect(parseInitArgs([])).not.toHaveProperty("ai");
  });

  it("rejects an unknown engine", () => {
    expect(() => parseInitArgs(["--database", "oracle"])).toThrow(
      "--database must be one of pg, mysql, mssql, sqlite",
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseInitArgs(["--force"])).toThrow();
  });

  it("rejects a positional argument", () => {
    expect(() => parseInitArgs(["my-api"])).toThrow();
  });
});

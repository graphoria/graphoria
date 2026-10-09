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

  it("answers the database name question with --db-name", () => {
    expect(parseInitArgs(["--db-name", "shop"]).dbName).toBe("shop");
    expect(parseInitArgs(["--db-name=shop"]).dbName).toBe("shop");
    expect(parseInitArgs([])).not.toHaveProperty("dbName");
  });

  it("answers the database port question with --db-port", () => {
    expect(parseInitArgs(["--db-port", "15432"]).dbPort).toBe(15432);
    expect(parseInitArgs(["--db-port=15432"]).dbPort).toBe(15432);
    expect(parseInitArgs([])).not.toHaveProperty("dbPort");
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

  it("answers the Redis question with --redis or --no-redis", () => {
    expect(parseInitArgs(["--redis"]).redis).toBe(true);
    expect(parseInitArgs(["--no-redis"]).redis).toBe(false);
    expect(parseInitArgs([])).not.toHaveProperty("redis");
  });

  it("answers the data-tools question with --data-tools or --no-data-tools", () => {
    expect(parseInitArgs(["--data-tools"]).dataTools).toBe(true);
    expect(parseInitArgs(["--no-data-tools"]).dataTools).toBe(false);
    expect(parseInitArgs([])).not.toHaveProperty("dataTools");
  });

  it("rejects an unknown engine", () => {
    expect(() => parseInitArgs(["--database", "oracle"])).toThrow(
      "--database must be one of pg, mysql, mssql, sqlite",
    );
  });

  it("rejects a database name SQL would not accept", () => {
    expect(() => parseInitArgs(["--db-name", "My-DB"])).toThrow(
      "--db-name: Use lowercase letters, digits and _, not starting with a digit, up to 63 characters.",
    );
  });

  it("rejects a database port out of range or not a number", () => {
    expect(() => parseInitArgs(["--db-port", "70000"])).toThrow(
      "--db-port: Use a port number from 1 to 65535.",
    );
    expect(() => parseInitArgs(["--db-port", "54x"])).toThrow(
      "--db-port: Use a port number from 1 to 65535.",
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseInitArgs(["--force"])).toThrow();
  });

  it("rejects a positional argument", () => {
    expect(() => parseInitArgs(["my-api"])).toThrow();
  });
});

import { describe, expect, it } from "bun:test";

import { EnvZod } from "./env";

describe("EnvZod AUTH_STRATEGY", () => {
  const baseEnv = {
    ADMIN_SECRET: "x",
    JWT_SECRET: "y",
  };

  it("leaves authStrategy undefined when AUTH_STRATEGY is unset", () => {
    const env = EnvZod.parse(baseEnv);
    expect(env.authStrategy).toBeUndefined();
  });

  it("parses jwt", () => {
    const env = EnvZod.parse({ ...baseEnv, AUTH_STRATEGY: "jwt" });
    expect(env.authStrategy).toBe("jwt");
  });

  it("parses paseto_local", () => {
    const env = EnvZod.parse({ ...baseEnv, AUTH_STRATEGY: "paseto_local" });
    expect(env.authStrategy).toBe("paseto_local");
  });

  it("parses paseto_public", () => {
    const env = EnvZod.parse({ ...baseEnv, AUTH_STRATEGY: "paseto_public" });
    expect(env.authStrategy).toBe("paseto_public");
  });

  it("rejects invalid AUTH_STRATEGY values", () => {
    expect(() => EnvZod.parse({ ...baseEnv, AUTH_STRATEGY: "bogus" })).toThrow();
  });
});

describe("EnvZod boolean flags", () => {
  const baseEnv = {
    ADMIN_SECRET: "x",
    JWT_SECRET: "y",
  };

  it('parses the string "false" as false (not Boolean("false") === true)', () => {
    const env = EnvZod.parse({
      ...baseEnv,
      CONSOLE_ENABLED: "false",
      CORS_ENABLED: "false",
      PRINT_SCHEMAS: "false",
      QUERY_ON_RESPONSE: "false",
      AI_ENABLED: "false",
      AI_GRAPHQL_ENABLED: "false",
      AI_REST_ENABLED: "false",
      AI_MCP_ENABLED: "false",
      AI_MCP_REQUIRE_ADMIN_SECRET: "false",
    });

    expect(env.console.enabled).toBe(false);
    expect(env.enableCors).toBe(false);
    expect(env.schemas.print).toBe(false);
    expect(env.queryOnResponse).toBe(false);
    expect(env.ai.enabled).toBe(false);
    expect(env.ai.graphqlEnabled).toBe(false);
    expect(env.ai.restEnabled).toBe(false);
    expect(env.ai.mcp.enabled).toBe(false);
    expect(env.ai.mcp.requireAdminSecret).toBe(false);
  });

  it("parses truthy strings as true", () => {
    const env = EnvZod.parse({
      ...baseEnv,
      CONSOLE_ENABLED: "true",
      PRINT_SCHEMAS: "1",
      CORS_ENABLED: "yes",
    });
    expect(env.console.enabled).toBe(true);
    expect(env.schemas.print).toBe(true);
    expect(env.enableCors).toBe(true);
  });

  it("applies defaults when unset", () => {
    const env = EnvZod.parse(baseEnv);
    expect(env.console.enabled).toBe(false);
    expect(env.enableCors).toBe(true);
    expect(env.schemas.print).toBe(false);
    expect(env.ai.graphqlEnabled).toBe(true);
    expect(env.ai.enabled).toBeUndefined();
  });

  it("rejects unrecognized boolean strings instead of silently coercing", () => {
    expect(() => EnvZod.parse({ ...baseEnv, CONSOLE_ENABLED: "flase" })).toThrow();
  });
});

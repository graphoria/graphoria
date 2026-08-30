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

describe("EnvZod MAX_QUERY_DEPTH", () => {
  const baseEnv = {
    ADMIN_SECRET: "x",
    JWT_SECRET: "y",
  };

  it("defaults to 8 so the depth limit is on without configuration", () => {
    expect(EnvZod.parse(baseEnv).maxQueryDepth).toBe(8);
  });

  it("keeps 0 as the explicit opt-out for unlimited depth", () => {
    expect(EnvZod.parse({ ...baseEnv, MAX_QUERY_DEPTH: "0" }).maxQueryDepth).toBe(0);
  });

  it("parses an explicit limit", () => {
    expect(EnvZod.parse({ ...baseEnv, MAX_QUERY_DEPTH: "20" }).maxQueryDepth).toBe(20);
  });
});

describe("EnvZod QUERY_TIMEOUT_MS", () => {
  const baseEnv = {
    ADMIN_SECRET: "x",
    JWT_SECRET: "y",
  };

  it("bounds every query by default", () => {
    expect(EnvZod.parse(baseEnv).queryTimeoutMs).toBe(10_000);
  });

  it("coerces the string form", () => {
    expect(EnvZod.parse({ ...baseEnv, QUERY_TIMEOUT_MS: "2500" }).queryTimeoutMs).toBe(2500);
  });

  it("keeps 0 as the explicit opt-out", () => {
    expect(EnvZod.parse({ ...baseEnv, QUERY_TIMEOUT_MS: "0" }).queryTimeoutMs).toBe(0);
  });

  it("rejects a negative timeout", () => {
    expect(() => EnvZod.parse({ ...baseEnv, QUERY_TIMEOUT_MS: "-1" })).toThrow();
  });
});

describe("EnvZod MAX_QUERY_COST", () => {
  const baseEnv = {
    ADMIN_SECRET: "x",
    JWT_SECRET: "y",
  };

  it("ships off, so an operator opts in to the cost budget", () => {
    expect(EnvZod.parse(baseEnv).maxQueryCost).toBe(0);
  });

  it("coerces the string form", () => {
    expect(EnvZod.parse({ ...baseEnv, MAX_QUERY_COST: "100000" }).maxQueryCost).toBe(100_000);
  });

  it("rejects a negative budget", () => {
    expect(() => EnvZod.parse({ ...baseEnv, MAX_QUERY_COST: "-1" })).toThrow();
  });
});

describe("EnvZod RATE_LIMIT_*", () => {
  const baseEnv = {
    ADMIN_SECRET: "x",
    JWT_SECRET: "y",
  };

  it("ships off, for both authenticated and anonymous callers", () => {
    const env = EnvZod.parse(baseEnv);

    expect(env.rateLimit.max).toBe(0);
    expect(env.rateLimit.anonymousMax).toBe(0);
  });

  it("defaults the window to a minute", () => {
    expect(EnvZod.parse(baseEnv).rateLimit.windowMs).toBe(60_000);
  });

  it("coerces the string forms", () => {
    const env = EnvZod.parse({
      ...baseEnv,
      RATE_LIMIT_MAX: "600",
      RATE_LIMIT_ANONYMOUS_MAX: "60",
      RATE_LIMIT_WINDOW_MS: "30000",
    });

    expect(env.rateLimit).toMatchObject({ max: 600, anonymousMax: 60, windowMs: 30_000 });
  });

  it("trusts the socket address unless told otherwise", () => {
    expect(EnvZod.parse(baseEnv).rateLimit.trustProxy).toBe(false);
  });

  it('parses the string "false" for RATE_LIMIT_TRUST_PROXY', () => {
    expect(EnvZod.parse({ ...baseEnv, RATE_LIMIT_TRUST_PROXY: "false" }).rateLimit.trustProxy).toBe(
      false,
    );
    expect(EnvZod.parse({ ...baseEnv, RATE_LIMIT_TRUST_PROXY: "true" }).rateLimit.trustProxy).toBe(
      true,
    );
  });

  it("rejects a negative limit", () => {
    expect(() => EnvZod.parse({ ...baseEnv, RATE_LIMIT_MAX: "-1" })).toThrow();
    expect(() => EnvZod.parse({ ...baseEnv, RATE_LIMIT_ANONYMOUS_MAX: "-1" })).toThrow();
  });

  it("rejects a window of zero", () => {
    expect(() => EnvZod.parse({ ...baseEnv, RATE_LIMIT_WINDOW_MS: "0" })).toThrow();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ConfigurationFn } from "./config";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

/** The engine boots from the function a `graphoria.ts` exports, passed as it is imported. */

const configure = (() => ({
  name: "inline-configuration-test",
  version: "1.0.0",
  databases: [
    {
      name: "default",
      enabled: true,
      type: "sqlite" as const,
      connection: { filename: ":memory:" },
    },
  ],
})) satisfies ConfigurationFn;

let engine: Awaited<ReturnType<typeof import("./index").createGraphQLEngine>>;

beforeAll(async () => {
  const { createGraphQLEngine } = await import("./index");
  const { env } = await import("./singletons/env");

  engine = await createGraphQLEngine({
    dbConnectRetryMs: 0,
    // A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: configure,
  });
});

afterAll(() => engine?.close());

describe("createGraphQLEngine", () => {
  it("boots from a configuration function passed inline", async () => {
    expect(await engine.execute("{ __typename }")).toEqual({ data: { __typename: "Query" } });
  });
});

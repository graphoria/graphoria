import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * AUTH_STORE through the two boots that read it. The server requires it when
 * auth is on; the in-process engine verifies no token, so it does not. Either
 * boot honours one that is set, auth on or off.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-auth-store-"));
  new SQLiteDatabase(join(dir, "app.db"), { create: true }).close();
});

afterEach(async () => {
  const { disconnectDatabases } = await import("../singletons/databases");
  const { setCronJobs } = await import("../singletons/cron");
  const { setQueueManager } = await import("../singletons/queues");

  await disconnectDatabases();
  setCronJobs(null);
  setQueueManager(undefined);
  await rm(dir, { recursive: true, force: true });
});

// AUTH_STORE, RATE_LIMIT_STORE and the JWT secret are always passed, so the ambient ones never
// matter. A boot sets the process-wide query timeout, so it gets 0, which is its value before any
// boot.
const bootOptions = async (
  authEnabled: boolean,
  authStore: string | undefined,
  filename = join(dir, "app.db"),
) => {
  const { env } = await import("../singletons/env");

  return {
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    authStore,
    rateLimit: { ...env.rateLimit, store: "memory" },
    jwt: { ...env.jwt, secrets: ["auth-store-boot-test"] },
    configuration: {
      name: "auth-store-boot-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename },
        },
      ],
      auth: {
        enabled: authEnabled,
        database: "default",
        permissions: { anonymous: { tables: "ALL" } },
      },
    } as never,
  };
};

describe("AUTH_STORE at boot", () => {
  it("is required by the server when auth is on", async () => {
    const { createHandlers } = await import("../index");

    await expect(createHandlers(await bootOptions(true, undefined))).rejects.toThrow(
      "AUTH_STORE is required when auth is enabled",
    );
  });

  it("stays optional for the server when auth is off", async () => {
    const { createHandlers } = await import("../index");

    await expect(createHandlers(await bootOptions(false, undefined))).resolves.toBeDefined();
  });

  it.each(["createHandlers", "createGraphQLEngine"] as const)(
    "is still checked by %s when auth is off",
    async (boot) => {
      const index = await import("../index");

      await expect(index[boot](await bootOptions(false, "nope"))).rejects.toThrow(
        "AUTH_STORE=nope names no store",
      );
    },
  );

  it("refuses a store it misnames before any database connects", async () => {
    const { createHandlers } = await import("../index");
    // A file in a directory that does not exist fails to open, at once.
    const unopenable = join(dir, "missing", "app.db");

    await expect(createHandlers(await bootOptions(true, "nope", unopenable))).rejects.toThrow(
      "AUTH_STORE=nope names no store",
    );
  });

  it("stays optional for the engine when auth is on", async () => {
    const { createGraphQLEngine } = await import("../index");

    const engine = await createGraphQLEngine(await bootOptions(true, undefined));

    expect(engine.roles).toContain("anonymous");
  });

  it("is still checked by the engine when it is set", async () => {
    const { createGraphQLEngine } = await import("../index");

    await expect(createGraphQLEngine(await bootOptions(true, "nope"))).rejects.toThrow(
      "AUTH_STORE=nope names no store",
    );
  });
});

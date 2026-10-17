import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiPackage } from "./ai/adapter";
import type { QueueAdapter } from "./queues/adapter";

// `singletons/env` parses process.env at module load, once for the whole run, so
// the JWT secret that later files sign with has to be set here too.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt";
process.env.LOG_LEVEL ??= "silent";

/**
 * A boot that fails once it has connected closes what it opened, with the
 * shutdown's own steps, and rejects with the error it failed on, so the
 * process can boot again.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-boot-teardown-"));
  new SQLiteDatabase(join(dir, "app.db"), { create: true }).close();
});

afterEach(async () => {
  const { disconnectDatabases } = await import("./singletons/databases");
  const { getCronJobs, setCronJobs } = await import("./singletons/cron");
  const { setQueueManager } = await import("./singletons/queues");

  getCronJobs()?.stopAll();
  setCronJobs(null);
  await disconnectDatabases();
  setQueueManager(undefined);
  await rm(dir, { recursive: true, force: true });
});

// The JWT secret, both stores and the AI switches are always passed, so the ambient ones never
// matter. A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
const bootOptions = async ({ auth = false, ai = false, queues = [] as object[] } = {}) => {
  const { env } = await import("./singletons/env");

  return {
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    jwt: { ...env.jwt, secrets: ["boot-teardown-test"] },
    ai: {
      ...env.ai,
      enabled: ai,
      secrets: [],
      mcp: { ...env.ai.mcp, enabled: false, secrets: [] },
    },
    configuration: {
      name: "boot-teardown-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename: join(dir, "app.db") },
        },
      ],
      cron: [{ name: "nightly", pattern: "0 3 * * *", query: "{ __typename }" }],
      queues,
      auth: { enabled: auth, database: "default", permissions: {} },
    } as never,
  };
};

const withoutAiPackage = async () => {
  const aiModule = await import("./singletons/ai");

  return spyOn(
    aiModule as unknown as { importAiPackage: () => Promise<AiPackage | undefined> },
    "importAiPackage",
  ).mockResolvedValue(undefined);
};

// Started by a fake adapter, so nothing reaches a broker.
const QUEUE = {
  type: "rabbitmq",
  name: "events",
  connection: {
    hostname: "localhost",
    port: 5672,
    username: "guest",
    password: "guest",
    vhost: "/",
  },
  publishers: { orderCreated: { topic: "orders" } },
  topics: { orders: {} },
};

describe("a boot that fails once it has connected", () => {
  // The token key is checked once the database is connected, before the token service is set.
  it.each(["createHandlers", "createGraphQLEngine"] as const)(
    "closes the database %s connected, and rejects with the error it failed on",
    async (boot) => {
      const index = await import("./index");
      const { databasesConnections } = await import("./singletons/databases");
      const { env } = await import("./singletons/env");
      const options = await bootOptions({ auth: true });

      await expect(index[boot]({ ...options, jwt: { ...env.jwt, secrets: [] } })).rejects.toThrow(
        "JWT_SECRET environment variable is required by the jwt token strategy",
      );
      expect(Object.keys(databasesConnections)).toEqual([]);
    },
  );

  // The server starts its agent once cron is scheduled.
  it("stops the cron jobs it scheduled, so the next boot schedules its own", async () => {
    const { createHandlers } = await import("./index");
    const { databasesConnections } = await import("./singletons/databases");
    const { getCronJobs } = await import("./singletons/cron");
    const spy = await withoutAiPackage();

    try {
      await expect(createHandlers(await bootOptions({ ai: true }))).rejects.toThrow(
        "ai.enabled requires @graphoria/ai (add it to dependencies)",
      );
    } finally {
      spy.mockRestore();
    }
    expect(getCronJobs()).toBeNull();
    expect(Object.keys(databasesConnections)).toEqual([]);

    await createHandlers(await bootOptions());

    expect(getCronJobs()?.getAllJobs()).toHaveLength(1);
  });

  // The queues start before the agent, so they are up when it fails.
  it("cleans up the queues it started", async () => {
    const { createHandlers } = await import("./index");
    const queues = await import("./singletons/queues");
    const { instantiateQueues } = queues;
    let cleanups = 0;
    const rabbitmq: QueueAdapter = {
      start: async () => ({
        publisherMap: () => ({}),
        sendMessage: async () => true,
        connections: () => [],
        cleanup: async () => {
          cleanups++;
        },
      }),
    };
    const start = spyOn(queues, "instantiateQueues").mockImplementation((configs) =>
      instantiateQueues(configs, { adapters: { rabbitmq } }),
    );
    const spy = await withoutAiPackage();

    try {
      await expect(
        createHandlers(await bootOptions({ ai: true, queues: [QUEUE] })),
      ).rejects.toThrow("ai.enabled requires @graphoria/ai (add it to dependencies)");
    } finally {
      spy.mockRestore();
      start.mockRestore();
    }
    expect(cleanups).toBe(1);
  });

  it("closes the database the engine connected when its agent cannot start", async () => {
    const { createGraphQLEngine } = await import("./index");
    const { databasesConnections } = await import("./singletons/databases");
    const spy = await withoutAiPackage();

    try {
      await expect(createGraphQLEngine(await bootOptions({ ai: true }))).rejects.toThrow(
        "ai.enabled requires @graphoria/ai (add it to dependencies)",
      );
    } finally {
      spy.mockRestore();
    }
    expect(Object.keys(databasesConnections)).toEqual([]);
  });

  // Bun.serve throws at once when the port is taken, once the whole boot is done.
  it("closes what createBunServer opened when its port is taken", async () => {
    const { createBunServer } = await import("./index");
    const { databasesConnections } = await import("./singletons/databases");
    const { getCronJobs } = await import("./singletons/cron");
    const { env } = await import("./singletons/env");
    const taken = Bun.serve({ port: 0, fetch: () => new Response(null) });

    try {
      await expect(
        createBunServer({
          ...(await bootOptions()),
          port: taken.port,
          shutdown: { ...env.shutdown, handleSignals: false },
        }),
      ).rejects.toThrow("Failed to start server");
    } finally {
      await taken.stop(true);
    }
    expect(getCronJobs()).toBeNull();
    expect(Object.keys(databasesConnections)).toEqual([]);
  });
});

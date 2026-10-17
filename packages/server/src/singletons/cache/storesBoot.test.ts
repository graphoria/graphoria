import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * RATE_LIMIT_STORE, a leftover CACHE_STORE and the declared stores nothing
 * reads, through the server boot that checks them.
 */

// Nothing listens here, and no test sends these clients a command.
const shared = { type: "redis" as const, url: "redis://127.0.0.1:6392" };
const UNREAD = "cache store is declared but nothing reads it";

let dir: string;

// What a boot starts, which an earlier file's boot may have left behind.
const stopStarted = async () => {
  const { setCronJobs } = await import("../cron");
  const { setQueueManager } = await import("../queues");

  setCronJobs(null);
  setQueueManager(undefined);
};

beforeEach(async () => {
  await stopStarted();
  dir = await mkdtemp(join(tmpdir(), "graphoria-stores-boot-"));
  new SQLiteDatabase(join(dir, "app.db"), { create: true }).close();
});

afterEach(async () => {
  const { disconnectDatabases } = await import("../databases");
  const { closeCacheRedisClient } = await import("./redisClient");
  const { setCaches } = await import("./stores");

  await disconnectDatabases();
  closeCacheRedisClient();
  setCaches(null);
  await stopStarted();
  await rm(dir, { recursive: true, force: true });
});

// The rate limit, the token store and the leftover flag are always passed, so the ambient env
// does not matter. A boot sets the process-wide query timeout, so it gets 0, which is its value
// before any boot.
const bootOptions = (
  store: string,
  {
    max = 0,
    leftoverCacheStore = false,
    authStore = undefined as string | undefined,
    filename = join(dir, "app.db"),
  } = {},
) => ({
  dbConnectRetryMs: 0,
  queryTimeoutMs: 0,
  leftoverCacheStore,
  authStore,
  rateLimit: { max, anonymousMax: 0, windowMs: 60_000, trustProxy: false, store },
  configuration: {
    name: "stores-boot-test",
    version: "1.0.0",
    caches: { stores: { shared } },
    databases: [
      {
        name: "default",
        enabled: true,
        type: "sqlite",
        connection: { filename },
      },
    ],
  } as never,
});

describe("RATE_LIMIT_STORE at boot", () => {
  it("refuses a store caches.stores lacks, with no limit set, before queues and cron start", async () => {
    const { createHandlers } = await import("../../index");
    const queues = await import("../queues");
    const { getCronJobs } = await import("../cron");
    const idle = queues.queueManager;

    await expect(createHandlers(bootOptions("nope"))).rejects.toThrow(
      "RATE_LIMIT_STORE=nope names no store: declare it in caches.stores, or set RATE_LIMIT_STORE=memory",
    );
    expect(queues.queueManager).toBe(idle);
    expect(getCronJobs()).toBeNull();
  });

  it("refuses a store caches.stores lacks before any database connects", async () => {
    const { createHandlers } = await import("../../index");
    // A file in a directory that does not exist fails to open, at once.
    const filename = join(dir, "missing", "app.db");

    await expect(createHandlers(bootOptions("nope", { filename }))).rejects.toThrow(
      "RATE_LIMIT_STORE=nope names no store",
    );
  });

  it("refuses a store caches.stores lacks before the token store connects", async () => {
    const { createHandlers } = await import("../../index");
    const redis = await import("../../utils/redis");
    const connects = spyOn(redis, "createRedisClient");

    try {
      await expect(createHandlers(bootOptions("nope", { authStore: "shared" }))).rejects.toThrow(
        "RATE_LIMIT_STORE=nope names no store",
      );
      expect(connects).not.toHaveBeenCalled();
    } finally {
      connects.mockRestore();
    }
  });

  it.each(["memory", "shared"])("boots with RATE_LIMIT_STORE=%s", async (store) => {
    const { createHandlers } = await import("../../index");
    const queues = await import("../queues");
    const { getCronJobs } = await import("../cron");
    const idle = queues.queueManager;

    await createHandlers(bootOptions(store));

    expect(queues.queueManager).not.toBe(idle);
    expect(getCronJobs()).not.toBeNull();
  });
});

describe("store warnings at boot", () => {
  const spyOnWarn = async () => {
    const { logger } = await import("../../logging");
    return spyOn(logger("graphoria"), "warn").mockImplementation((() => {}) as never);
  };

  it("warns about a leftover CACHE_STORE and boots anyway", async () => {
    const { createHandlers } = await import("../../index");
    const warn = await spyOnWarn();

    try {
      await createHandlers(bootOptions("memory", { leftoverCacheStore: true }));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("CACHE_STORE is no longer read"));
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet about CACHE_STORE when none is set", async () => {
    const { createHandlers } = await import("../../index");
    const warn = await spyOnWarn();

    try {
      await createHandlers(bootOptions("memory"));

      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("CACHE_STORE"));
    } finally {
      warn.mockRestore();
    }
  });

  it("warns about a declared store nothing reads", async () => {
    const { createHandlers } = await import("../../index");
    const warn = await spyOnWarn();

    try {
      await createHandlers(bootOptions("memory"));

      expect(warn).toHaveBeenCalledWith({ store: "shared" }, UNREAD);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns about the store RATE_LIMIT_STORE names while no limit is set", async () => {
    const { createHandlers } = await import("../../index");
    const warn = await spyOnWarn();

    try {
      await createHandlers(bootOptions("shared"));

      expect(warn).toHaveBeenCalledWith({ store: "shared" }, UNREAD);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn about the store AUTH_STORE names, with auth off too", async () => {
    const { createHandlers } = await import("../../index");
    const { getTokenService, setTokenService } = await import("../authentication");
    const tokenService = getTokenService();
    const warn = await spyOnWarn();

    try {
      await createHandlers(bootOptions("memory", { authStore: "shared" }));

      expect(warn).not.toHaveBeenCalledWith({ store: "shared" }, UNREAD);
    } finally {
      warn.mockRestore();
      getTokenService().close();
      setTokenService(tokenService);
    }
  });

  it("does not warn about the store the rate limiter reads", async () => {
    const { createHandlers } = await import("../../index");
    const warn = await spyOnWarn();

    try {
      await createHandlers(bootOptions("shared", { max: 5 }));

      expect(warn).not.toHaveBeenCalledWith({ store: "shared" }, UNREAD);
    } finally {
      warn.mockRestore();
    }
  });
});

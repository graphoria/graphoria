import { describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * A shutdown lets what is in flight finish, turns new callers away, says
 * goodbye to websockets, and leaves nothing behind that would reconnect.
 */

const ENGINE = "pg" as const;
const SLOW_MS = 1_000;

const slowOperationConfig = {
  auth: {
    enabled: false,
    database: "",
    permissions: {
      anonymous: { tables: "ALL", storedProcedures: "ALL", operations: "ALL" },
    },
  },
  operations: {
    slow: {
      handler: async () => {
        await Bun.sleep(SLOW_MS);
        return { slow: true };
      },
      rest: { path: "/slow", method: "GET" },
    },
  },
} as never;

const openSocket = async (started: StartedServer) => {
  const socket = new WebSocket(`ws://localhost:${started.context.server.port}/graphql`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("websocket failed to open"));
  });
  return socket;
};

const waitForPending = async (started: StartedServer) => {
  const deadline = Date.now() + 2_000;
  while (started.context.server.pendingRequests === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
};

describe.skipIf(!integrationEnabled)("graceful shutdown", () => {
  it("drains in-flight work, refuses new callers, closes websockets with 1001, then closes pools and Redis", async () => {
    const started = await startServer({ engine: ENGINE, config: slowOperationConfig });
    const { databasesConnections } = await import("../../singletons/databases");
    const { getCacheRedisClient } = await import("../../singletons/cache/redisClient");
    try {
      const port = started.context.server.port;
      const ready = await Bun.fetch(`http://localhost:${port}/health/ready`);
      expect(ready.status).toBe(200);
      const redis = getCacheRedisClient();
      expect(redis.connected).toBe(true);

      const socket = await openSocket(started);
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", (event) => resolve(event)),
      );

      const inFlight = started.context.rest("/slow");
      await waitForPending(started);

      const shutdown = started.shutdown();

      const refused = await Bun.fetch(`http://localhost:${port}/health/live`).then(
        () => "answered",
        () => "refused",
      );
      expect(refused).toBe("refused");

      const closeEvent = await closed;
      expect(closeEvent.code).toBe(1001);
      expect(closeEvent.wasClean).toBe(true);

      const response = await inFlight;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ slow: true });

      expect(await shutdown).toBe(true);
      expect(Object.keys(databasesConnections)).toEqual([]);

      // keepRedisConnected's first reconnect would land 1 s after the close.
      await Bun.sleep(1_500);
      expect(redis.connected).toBe(false);
    } finally {
      await started.stop();
    }
  }, 15_000);

  it("resets a request that outlasts the timeout and reports the shutdown as not clean", async () => {
    const started = await startServer({
      engine: ENGINE,
      skipSeed: true,
      config: slowOperationConfig,
      env: { shutdown: { timeoutMs: 100, handleSignals: false } },
    });
    try {
      const inFlight = started.context.rest("/slow").then(
        (response) => response.status,
        () => "reset",
      );
      await waitForPending(started);

      expect(await started.shutdown()).toBe(false);
      expect(await inFlight).toBe("reset");
    } finally {
      await started.stop();
    }
  }, 15_000);

  it("installs SIGTERM and SIGINT listeners only when signal handling is on", async () => {
    const before = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
    };

    const off = await startServer({ engine: ENGINE, skipSeed: true });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM.length);
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT.length);
    } finally {
      await off.stop();
    }

    const on = await startServer({
      engine: ENGINE,
      skipSeed: true,
      env: { shutdown: { timeoutMs: 8_000, handleSignals: true } },
    });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM.length + 1);
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT.length + 1);
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].includes(listener)) process.off(signal, listener);
        }
      }
      await on.stop();
    }
  });
});

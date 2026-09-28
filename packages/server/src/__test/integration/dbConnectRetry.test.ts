import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";

import type { StartedServer } from "./harness";
import type { TcpProxy } from "./tcpProxy";

import { CONNECTIONS } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";
import { createTcpProxy } from "./tcpProxy";

/**
 * Boot against a database that is not there yet. The server reaches it through
 * a proxy, so the test can hold the database back and hand it over without
 * stopping the container the other suites share.
 *
 * PostgreSQL only: the retry wraps every engine's connect the same way.
 */

const ENGINE = "pg" as const;

describe.skipIf(!integrationEnabled)("database connect at boot", () => {
  let proxy: TcpProxy;
  let started: StartedServer | undefined;

  const throughProxy = () => ({
    databases: [
      {
        name: "default",
        enabled: true,
        type: ENGINE,
        connection: { ...CONNECTIONS.pg, host: "127.0.0.1", port: proxy.port },
      },
    ],
  });

  beforeAll(async () => {
    await seedEngine(ENGINE);
    proxy = await createTcpProxy({ host: CONNECTIONS.pg.host, port: CONNECTIONS.pg.port });
  });

  afterEach(async () => {
    await started?.stop();
    started = undefined;
    await proxy.up();
  });

  afterAll(async () => {
    await proxy?.close();
  });

  it("boots once the database comes back inside the window", async () => {
    const { logger } = await import("../../logging");
    let comingBack: Promise<void> | undefined;
    // The database comes back 1.5 s after the first failed attempt, whenever
    // that is, so the test does not depend on how long boot takes to get there.
    const warn = spyOn(logger("db"), "warn").mockImplementation((() => {
      comingBack ??= Bun.sleep(1500).then(() => proxy.up());
    }) as never);

    try {
      await proxy.down();
      started = await startServer({
        engine: ENGINE,
        skipSeed: true,
        config: throughProxy(),
        env: { dbConnectRetryMs: 20_000 },
      });

      expect(warn).toHaveBeenCalled();
      const response = await fetch(`http://localhost:${started.context.server.port}/health/ready`);
      expect(response.status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("gives up once the window has elapsed", async () => {
    await proxy.down();
    const startedAt = Date.now();

    await expect(
      startServer({
        engine: ENGINE,
        skipSeed: true,
        config: throughProxy(),
        env: { dbConnectRetryMs: 3_000 },
      }),
    ).rejects.toThrow();

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(6_000);
  }, 30_000);
});

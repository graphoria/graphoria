import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";
import type { TcpProxy } from "./tcpProxy";

import { CONNECTIONS, REDIS_URL } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { createTcpProxy } from "./tcpProxy";

/**
 * The server reaches its database through a proxy, so the test can take the
 * database away and give it back without stopping the container the other
 * suites share. Redis is checked too: the suite runs with `CACHE_STORE=redis`.
 */

const ENGINE = "pg" as const;
const RECOVERY_DEADLINE_MS = 15_000;

type Readiness = { status: string; checks: Array<{ kind: string; name?: string; ok: boolean }> };

const getFrom = async (started: StartedServer, path: string) => {
  const response = await Bun.fetch(`http://localhost:${started.context.server.port}${path}`);
  return { status: response.status, body: (await response.json()) as Readiness };
};

describe.skipIf(!integrationEnabled)("health endpoints", () => {
  let proxy: TcpProxy;
  let started: StartedServer;

  const get = (path: string) => getFrom(started, path);

  beforeAll(async () => {
    proxy = await createTcpProxy({ host: CONNECTIONS.pg.host, port: CONNECTIONS.pg.port });
    started = await startServer({
      engine: ENGINE,
      config: {
        databases: [
          {
            name: "default",
            enabled: true,
            type: ENGINE,
            connection: { ...CONNECTIONS.pg, host: "127.0.0.1", port: proxy.port },
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await proxy?.up();
    await started?.stop();
    await proxy?.close();
  });

  it("is ready while every dependency answers", async () => {
    expect(await get("/health/ready")).toEqual({
      status: 200,
      body: {
        status: "ok",
        checks: [
          { kind: "database", name: "default", ok: true },
          { kind: "redis", ok: true },
        ],
      },
    });
  });

  it("is unavailable while the database is down, and still live", async () => {
    await proxy.down();

    const { status, body } = await get("/health/ready");

    expect(status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.checks).toContainEqual({ kind: "database", name: "default", ok: false });
    expect(body.checks).toContainEqual({ kind: "redis", ok: true });
    expect((await get("/health/live")).status).toBe(200);
  });

  it(
    "is ready again once the database is back",
    async () => {
      await proxy.up();

      const deadline = Date.now() + RECOVERY_DEADLINE_MS;
      let last = await get("/health/ready");
      while (last.status !== 200 && Date.now() < deadline) {
        await Bun.sleep(250);
        last = await get("/health/ready");
      }

      expect(last.status).toBe(200);
    },
    RECOVERY_DEADLINE_MS + 5_000,
  );
});

describe.skipIf(!integrationEnabled)("health · redis is checked only where it is used", () => {
  const memoryCache = { cache: { store: "memory" as const, redisUrl: REDIS_URL } };

  const kindsWith = async (options: Parameters<typeof startServer>[0]) => {
    const started = await startServer(options);
    try {
      return (await getFrom(started, "/health/ready")).body.checks.map((check) => check.kind);
    } finally {
      await started.stop();
    }
  };

  it("skips redis with the memory cache and auth off", async () => {
    expect(await kindsWith({ engine: ENGINE, skipSeed: true, env: memoryCache })).toEqual([
      "database",
    ]);
  });

  it("checks redis with the memory cache when auth is on", async () => {
    const kinds = await kindsWith({
      engine: ENGINE,
      skipSeed: true,
      env: memoryCache,
      config: {
        auth: {
          enabled: true,
          database: "default",
          schema: "auth",
          autoCreateTables: true,
          permissions: { anonymous: { tables: "ALL" } },
        },
      } as never,
    });

    expect(kinds).toEqual(["database", "redis"]);
  });
});

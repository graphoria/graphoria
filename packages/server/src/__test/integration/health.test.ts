import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";
import type { TcpProxy } from "./tcpProxy";

import { CONNECTIONS, REDIS_URL } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { createTcpProxy } from "./tcpProxy";

/**
 * The server reaches its database through a proxy, so the test can take the
 * database away and give it back without stopping the container the other
 * suites share.
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
        // The harness's AUTH_STORE=redis: the token store is read with auth off too.
        checks: [
          { kind: "database", name: "default", ok: true },
          { kind: "redis", name: "redis", ok: true },
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
  const readyWith = async (options: Parameters<typeof startServer>[0]) => {
    const started = await startServer(options);
    try {
      return await getFrom(started, "/health/ready");
    } finally {
      await started.stop();
    }
  };
  const checksWith = async (options: Parameters<typeof startServer>[0]) =>
    (await readyWith(options)).body.checks.map((check) =>
      check.name && check.kind === "redis" ? `${check.kind}:${check.name}` : check.kind,
    );

  it("checks the store AUTH_STORE names with auth off too", async () => {
    expect(await checksWith({ engine: ENGINE, skipSeed: true })).toEqual([
      "database",
      "redis:redis",
    ]);
  });

  it("skips redis when nothing reads it", async () => {
    expect(
      await checksWith({ engine: ENGINE, skipSeed: true, env: { authStore: undefined } }),
    ).toEqual(["database"]);
  });

  const authOn = {
    auth: {
      enabled: true,
      database: "default",
      schema: "auth",
      autoCreateTables: true,
      permissions: { anonymous: { tables: "ALL" } },
    },
  };

  it("checks the store AUTH_STORE names when auth is on", async () => {
    const { body } = await readyWith({ engine: ENGINE, skipSeed: true, config: authOn as never });

    expect(body.checks.map((check) => check.kind)).toEqual(["database", "redis"]);
    expect(body.checks).toContainEqual({ kind: "redis", name: "redis", ok: true });
  });

  it("probes each store on its own URL and reports a dead one by name", async () => {
    const { status, body } = await readyWith({
      engine: ENGINE,
      config: {
        caches: {
          default: ["redis"],
          stores: {
            redis: { type: "redis", url: REDIS_URL },
            dead: { type: "redis", url: "redis://127.0.0.1:1" },
          },
        },
        operations: {
          tasks: {
            query: `query { app_tasks(limit: 1, orderBy: { id: ASC }) { id } }`,
            rest: { path: "/tasks", method: "GET" },
            cache: { ttl: 60_000, stores: ["redis", "dead"] },
          },
        },
      } as never,
    });

    expect(status).toBe(503);
    expect(body.checks).toContainEqual({ kind: "redis", name: "redis", ok: true });
    expect(body.checks).toContainEqual({ kind: "redis", name: "dead", ok: false });
  });
});

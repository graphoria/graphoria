import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { TcpProxy } from "./tcpProxy";

import { fieldName, REDIS_URL } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";
import { createTcpProxy } from "./tcpProxy";

/**
 * A boot that fails once it has connected closes what it opened: its database
 * pool, and the token store and cache pool that would otherwise stay connected
 * to Redis. Redis is reached through a proxy, which counts what is open.
 */

const ENGINE = "pg" as const;
const tasks = fieldName(ENGINE, "app", "tasks");

describe.skipIf(!integrationEnabled)("a boot that fails once it has connected", () => {
  let proxy: TcpProxy;

  beforeAll(async () => {
    await seedEngine(ENGINE);
    const target = new URL(REDIS_URL);
    proxy = await createTcpProxy({ host: target.hostname, port: Number(target.port) });
  });

  afterAll(async () => {
    await proxy?.close();
  });

  // The harness names this store AUTH_STORE, and the cached operation opens a cache pool on it.
  const config = (extra: object) =>
    ({
      caches: {
        default: ["redis"],
        stores: { redis: { type: "redis", url: `redis://127.0.0.1:${proxy.port}` } },
      },
      operations: {
        cached: {
          query: `query { ${tasks}(limit: 1, orderBy: { id: ASC }) { id } }`,
          rest: { path: "/cached", method: "GET" },
          cache: { ttl: 60_000 },
        },
      },
      ...extra,
    }) as never;

  const expectReleased = async (acceptedBefore: number) => {
    const { databasesConnections } = await import("../../singletons/databases");

    expect(proxy.accepted).toBeGreaterThan(acceptedBefore);
    expect(Object.keys(databasesConnections)).toEqual([]);
    // keepRedisConnected's first reconnect would land 1 s after the close.
    await Bun.sleep(1_500);
    expect(proxy.open).toBe(0);
  };

  it("closes them when it fails before the token service is set", async () => {
    const { env } = await import("../../singletons/env");
    const acceptedBefore = proxy.accepted;

    await expect(
      startServer({
        engine: ENGINE,
        skipSeed: true,
        config: config({
          auth: {
            enabled: true,
            database: "default",
            permissions: { anonymous: { tables: "ALL", storedProcedures: "ALL" } },
          },
        }),
        env: { jwt: { ...env.jwt, secrets: [] } },
      }),
    ).rejects.toThrow("JWT_SECRET environment variable is required");

    await expectReleased(acceptedBefore);
  });

  it("closes them when it fails after the boot", async () => {
    const { env } = await import("../../singletons/env");
    const acceptedBefore = proxy.accepted;

    await expect(
      startServer({
        engine: ENGINE,
        skipSeed: true,
        config: config({ ai: { enabled: true } }),
        env: {
          ai: {
            ...env.ai,
            enabled: true,
            restEnabled: true,
            secrets: ["ghost-agent-secret"],
            secretRole: "ghost",
          },
        },
      }),
    ).rejects.toThrow('AI_SECRET_ROLE is "ghost", which is not a configured role');

    await expectReleased(acceptedBefore);
  });
});

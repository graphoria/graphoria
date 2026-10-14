import { afterAll, describe, expect, it } from "bun:test";

import type { TcpProxy } from "./tcpProxy";

import { REDIS_URL } from "./config";
import { integrationEnabled } from "./harness";
import { createTcpProxy } from "./tcpProxy";

/**
 * Bun's Redis client stops retrying after `maxRetries` and then fails every
 * command, even once the server is back. The outage here outlasts those retries
 * on purpose — a shorter one recovers without any help and proves nothing.
 */

const OUTAGE_DEADLINE_MS = 60_000;
const RECOVERY_DEADLINE_MS = 45_000;

const ping = async (client: { ping(): Promise<string> }) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.ping(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 1000);
      }),
    ]);
  } catch (error) {
    return (error as Error).message;
  } finally {
    clearTimeout(timer);
  }
};

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
  intervalMs = 500,
) => {
  const deadline = Date.now() + deadlineMs;
  while (!(await condition())) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(intervalMs);
  }
  return true;
};

describe.skipIf(!integrationEnabled)("redis client during an outage", () => {
  it("fails a command at once rather than holding it until the server is back", async () => {
    const { closeRedisClient, createRedisClient } = await import("../../utils/redis");
    const target = new URL(REDIS_URL);
    const outage = await createTcpProxy({ host: target.hostname, port: Number(target.port) });
    const client = createRedisClient(`redis://127.0.0.1:${outage.port}`);
    try {
      await client.connect();
      await outage.down();
      // A command sent before the client notices the cut fails with the socket;
      // the one at stake is sent while it reconnects.
      expect(await waitFor(() => !client.connected, 5_000)).toBe(true);

      const started = performance.now();
      await expect(client.get("key")).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      closeRedisClient(client);
      await outage.close();
    }
  });
});

describe.skipIf(!integrationEnabled)("token store during an outage", () => {
  const storeBehindProxy = async () => {
    const { createTokenRepository } = await import("../../authentication/tokenRepository");
    const target = new URL(REDIS_URL);
    const proxy = await createTcpProxy({ host: target.hostname, port: Number(target.port) });
    return { proxy, repository: createTokenRepository(`redis://127.0.0.1:${proxy.port}`) };
  };

  // Once every pooled client answers, cut them all, until the store's ping fails.
  const cut = async ({ proxy, repository }: Awaited<ReturnType<typeof storeBehindProxy>>) => {
    const answers = () => repository.ping().catch(() => false);
    expect(await waitFor(answers, 5_000, 10)).toBe(true);
    await proxy.down();
    expect(await waitFor(async () => !(await answers()), 5_000, 10)).toBe(true);
  };

  // Nobody revoked the JTIs read here, so a read that fails closed answers true.
  it("waits out a short cut rather than failing closed", async () => {
    const store = await storeBehindProxy();
    try {
      await cut(store);
      const read = store.repository.isRevoked(crypto.randomUUID());
      await Bun.sleep(100);
      await store.proxy.up();

      expect(await read).toBe(false);
    } finally {
      store.repository.close();
      await store.proxy.close();
    }
  });

  it("fails closed once the cut outlasts the wait", async () => {
    const { TOKEN_STORE_RECONNECT_WAIT_MS } = await import("../../authentication/tokenRepository");
    const store = await storeBehindProxy();
    try {
      await cut(store);
      const started = performance.now();

      expect(await store.repository.isRevoked(crypto.randomUUID())).toBe(true);
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(TOKEN_STORE_RECONNECT_WAIT_MS);
      expect(waited).toBeLessThan(TOKEN_STORE_RECONNECT_WAIT_MS + 1_000);
    } finally {
      store.repository.close();
      await store.proxy.close();
    }
  });
});

describe.skipIf(!integrationEnabled)("redis client after a long outage", () => {
  let proxy: TcpProxy;

  afterAll(async () => {
    await proxy?.close();
  });

  it(
    "answers again once the server is back",
    async () => {
      const { createRedisClient } = await import("../../utils/redis");
      const target = new URL(REDIS_URL);
      proxy = await createTcpProxy({ host: target.hostname, port: Number(target.port) });

      const client = createRedisClient(`redis://127.0.0.1:${proxy.port}`);
      await client.connect();
      expect(await ping(client)).toBe("PONG");

      let gaveUp = false;
      const revive = client.onclose!;
      client.onclose = function (this: typeof client, error: Error) {
        gaveUp = true;
        revive.call(this, error);
      };

      await proxy.down();
      expect(await waitFor(() => gaveUp, OUTAGE_DEADLINE_MS)).toBe(true);

      await proxy.up();
      expect(await waitFor(async () => (await ping(client)) === "PONG", RECOVERY_DEADLINE_MS)).toBe(
        true,
      );

      // close() fires onclose too, and the helper would reconnect it.
      client.onclose = () => {};
      client.close();
    },
    OUTAGE_DEADLINE_MS + RECOVERY_DEADLINE_MS + 10_000,
  );
});

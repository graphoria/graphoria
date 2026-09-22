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

const waitFor = async (condition: () => boolean | Promise<boolean>, deadlineMs: number) => {
  const deadline = Date.now() + deadlineMs;
  while (!(await condition())) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(500);
  }
  return true;
};

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

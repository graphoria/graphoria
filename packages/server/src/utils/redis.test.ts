import { describe, expect, it } from "bun:test";

import type { RevivableRedisClient } from "./redis";

import { keepRedisConnected } from "./redis";

const createFakeClient = (outcomes: Array<"ok" | "fail">) => {
  const client: RevivableRedisClient & { connects: number } = {
    onclose: null,
    connects: 0,
    // A failed connect() may fire onclose as well as reject; the helper must not
    // count that as a second loss.
    connect: async () => {
      client.connects++;
      if ((outcomes.shift() ?? "ok") === "fail") {
        const error = new Error("Connection closed");
        client.onclose?.(error);
        throw error;
      }
    },
  };
  return client;
};

const createFakeTimers = () => {
  const pending: Array<{ fn: () => void; delay: number; unref: boolean }> = [];
  const setTimeout = ((fn: () => void, delay: number) => {
    const timer = { fn, delay, unref: false };
    pending.push(timer);
    return {
      unref: () => {
        timer.unref = true;
      },
    };
  }) as unknown as typeof globalThis.setTimeout;

  const runNext = async () => {
    const timer = pending.shift();
    if (!timer) throw new Error("no timer scheduled");
    timer.fn();
    // Let the connect() promise and its handlers settle.
    await Bun.sleep(0);
    return timer;
  };

  return { pending, setTimeout, runNext };
};

describe("keepRedisConnected", () => {
  it("does nothing until the client gives up", () => {
    const client = createFakeClient([]);
    const timers = createFakeTimers();

    keepRedisConnected(client, { setTimeout: timers.setTimeout });

    expect(timers.pending).toHaveLength(0);
    expect(client.connects).toBe(0);
  });

  it("reconnects after the client gives up", async () => {
    const client = createFakeClient(["ok"]);
    const timers = createFakeTimers();
    keepRedisConnected(client, { setTimeout: timers.setTimeout });

    client.onclose!(new Error("Connection closed"));
    const timer = await timers.runNext();

    expect(timer.delay).toBe(1000);
    expect(client.connects).toBe(1);
    expect(timers.pending).toHaveLength(0);
  });

  it("backs off while the server stays down, capped at 30s", async () => {
    const client = createFakeClient(["fail", "fail", "fail", "fail", "fail", "fail", "ok"]);
    const timers = createFakeTimers();
    keepRedisConnected(client, { setTimeout: timers.setTimeout });

    client.onclose!(new Error("Connection closed"));
    const delays: number[] = [];
    while (timers.pending.length > 0) delays.push((await timers.runNext()).delay);

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(client.connects).toBe(7);
  });

  it("starts the backoff over after a successful reconnect", async () => {
    const client = createFakeClient(["fail", "ok", "ok"]);
    const timers = createFakeTimers();
    keepRedisConnected(client, { setTimeout: timers.setTimeout });

    client.onclose!(new Error("Connection closed"));
    await timers.runNext();
    await timers.runNext();

    client.onclose!(new Error("Connection closed"));
    const timer = await timers.runNext();

    expect(timer.delay).toBe(1000);
  });

  it("keeps one reconnect in flight when the client closes again meanwhile", async () => {
    const client = createFakeClient(["ok"]);
    const timers = createFakeTimers();
    keepRedisConnected(client, { setTimeout: timers.setTimeout });

    client.onclose!(new Error("Connection closed"));
    client.onclose!(new Error("Connection closed"));

    expect(timers.pending).toHaveLength(1);
  });

  it("never holds the process open while waiting", () => {
    const client = createFakeClient([]);
    const timers = createFakeTimers();
    keepRedisConnected(client, { setTimeout: timers.setTimeout });

    client.onclose!(new Error("Connection closed"));

    expect(timers.pending[0]!.unref).toBe(true);
  });
});

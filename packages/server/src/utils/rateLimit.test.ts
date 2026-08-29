import { describe, expect, it } from "bun:test";

import { createMemoryRateLimitStore, createRedisRateLimitStore } from "./rateLimit";

const CAPACITY = 5;
const WINDOW_MS = 1000;
const REFILL_PER_MS = CAPACITY / WINDOW_MS;

const consumeN = async (
  store: { consume: (k: string, c: number, r: number, t: number) => Promise<unknown> },
  key: string,
  times: number,
) => {
  const results = [];
  for (let i = 0; i < times; i++)
    results.push(await store.consume(key, CAPACITY, REFILL_PER_MS, WINDOW_MS));
  return results as { allowed: boolean; retryAfterMs: number }[];
};

describe("memory rate limit store", () => {
  it("allows a burst of capacity requests", async () => {
    const store = createMemoryRateLimitStore({ now: () => 0 });

    const results = await consumeN(store, "k", CAPACITY);

    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("rejects the request after capacity is spent", async () => {
    const store = createMemoryRateLimitStore({ now: () => 0 });
    await consumeN(store, "k", CAPACITY);

    const result = await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS);

    expect(result.allowed).toBe(false);
  });

  it("reports the wait for one token on rejection", async () => {
    const store = createMemoryRateLimitStore({ now: () => 0 });
    await consumeN(store, "k", CAPACITY);

    const result = await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS);

    expect(result.retryAfterMs).toBe(Math.ceil(1 / REFILL_PER_MS));
  });

  it("refills part of the bucket after part of the window", async () => {
    let now = 0;
    const store = createMemoryRateLimitStore({ now: () => now });
    await consumeN(store, "k", CAPACITY);

    now = WINDOW_MS / 5;

    expect((await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS)).allowed).toBe(true);
    expect((await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS)).allowed).toBe(false);
  });

  it("refills the whole bucket after a whole window", async () => {
    let now = 0;
    const store = createMemoryRateLimitStore({ now: () => now });
    await consumeN(store, "k", CAPACITY);

    now = WINDOW_MS;
    const results = await consumeN(store, "k", CAPACITY);

    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("never refills past capacity, however long the bucket sat idle", async () => {
    let now = 0;
    const store = createMemoryRateLimitStore({ now: () => now });
    await consumeN(store, "k", CAPACITY);

    now = WINDOW_MS * 100;
    await consumeN(store, "k", CAPACITY);

    expect((await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS)).allowed).toBe(false);
  });

  it("counts each key separately", async () => {
    const store = createMemoryRateLimitStore({ now: () => 0 });
    await consumeN(store, "a", CAPACITY);

    expect((await store.consume("b", CAPACITY, REFILL_PER_MS, WINDOW_MS)).allowed).toBe(true);
  });

  it("serves a fresh caller after eviction under the key bound", async () => {
    const store = createMemoryRateLimitStore({ now: () => 0, maxKeys: 2 });
    await consumeN(store, "a", CAPACITY);
    await consumeN(store, "b", CAPACITY);
    await consumeN(store, "c", CAPACITY);

    expect((await store.consume("d", CAPACITY, REFILL_PER_MS, WINDOW_MS)).allowed).toBe(true);
  });
});

/**
 * The script runs inside Redis, so a fake client cannot execute it. This one
 * mirrors its semantics over a Map, which is enough to hold the command shape,
 * the argument order and the reply parsing honest; the script itself is proved
 * against a real Redis in the integration suite.
 */
const createFakeRedis = () => {
  const state = new Map<string, { tokens: number; ts: number }>();
  const calls: { command: string; args: string[] }[] = [];

  return {
    calls,
    state,
    send: async (command: string, args: string[]) => {
      calls.push({ command, args });
      const [, , key, capacityArg, refillArg, nowArg] = args;
      const capacity = Number(capacityArg);
      const refillPerMs = Number(refillArg);
      const nowMs = Number(nowArg);
      const stored = state.get(key!);
      let tokens = stored
        ? Math.min(capacity, stored.tokens + (nowMs - stored.ts) * refillPerMs)
        : capacity;
      let allowed = 0;
      if (tokens >= 1) {
        tokens -= 1;
        allowed = 1;
      }
      state.set(key!, { tokens, ts: nowMs });
      return [allowed, String(tokens)];
    },
  };
};

describe("redis rate limit store", () => {
  it("allows a burst of capacity requests", async () => {
    const store = createRedisRateLimitStore(createFakeRedis(), { now: () => 0 });

    const results = await consumeN(store, "k", CAPACITY);

    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("rejects the request after capacity is spent", async () => {
    const store = createRedisRateLimitStore(createFakeRedis(), { now: () => 0 });
    await consumeN(store, "k", CAPACITY);

    const result = await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS);

    expect(result).toEqual({ allowed: false, retryAfterMs: Math.ceil(1 / REFILL_PER_MS) });
  });

  it("evaluates one script against one key, with the bucket arguments after it", async () => {
    const client = createFakeRedis();
    const store = createRedisRateLimitStore(client, { now: () => 1234 });

    await store.consume("rl:user:42", CAPACITY, REFILL_PER_MS, WINDOW_MS);

    const [call] = client.calls;
    expect(call!.command).toBe("EVAL");
    expect(call!.args.slice(1)).toEqual([
      "1",
      "rl:user:42",
      String(CAPACITY),
      String(REFILL_PER_MS),
      "1234",
      String(WINDOW_MS),
    ]);
  });

  it("shares one budget between two stores on the same client", async () => {
    const client = createFakeRedis();
    const first = createRedisRateLimitStore(client, { now: () => 0 });
    const second = createRedisRateLimitStore(client, { now: () => 0 });

    await consumeN(first, "k", CAPACITY);

    expect((await second.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS)).allowed).toBe(false);
  });

  it("fails open when redis throws", async () => {
    const store = createRedisRateLimitStore(
      {
        send: async () => {
          throw new Error("connection refused");
        },
      },
      { now: () => 0, log: { warn: () => {} } },
    );

    expect(await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
  });

  it("warns once per window while redis is down", async () => {
    const warnings: string[] = [];
    let now = 0;
    const store = createRedisRateLimitStore(
      {
        send: async () => {
          throw new Error("connection refused");
        },
      },
      { now: () => now, log: { warn: (_obj: object, msg: string) => warnings.push(msg) } },
    );

    await consumeN(store, "k", 3);
    now = WINDOW_MS + 1;
    await store.consume("k", CAPACITY, REFILL_PER_MS, WINDOW_MS);

    expect(warnings).toHaveLength(2);
  });
});

import { describe, expect, it } from "bun:test";

import { createMemoryRateLimitStore } from "./rateLimit";

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

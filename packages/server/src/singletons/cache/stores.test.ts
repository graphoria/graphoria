import { afterEach, describe, expect, it } from "bun:test";

import type { CacheStore } from "./types";

import { LruCacheStore } from "./lruCacheStore";
import { RedisCacheStore } from "./redisCacheStore";
import { closeCacheRedisClient } from "./redisClient";
import { buildCacheStore, getCaches, setCaches } from "./stores";
import { TieredCacheStore } from "./tieredCacheStore";

// Clients connect on their first command, so no Redis has to listen here.
const shared = { type: "redis" as const, url: "redis://127.0.0.1:6392" };

afterEach(() => {
  setCaches(null);
  closeCacheRedisClient();
});

describe("buildCacheStore", () => {
  it("builds the in-process store when nothing is declared", () => {
    expect(getCaches()).toEqual({ default: ["memory"], stores: {} });
    expect(buildCacheStore("op", { ttl: 1_000, max: 10 })).toBeInstanceOf(LruCacheStore);
  });

  it("builds the bare Redis store for a one-store chain", () => {
    setCaches({ default: ["shared"], stores: { shared } });

    expect(buildCacheStore("op", { ttl: 1_000 })).toBeInstanceOf(RedisCacheStore);
  });

  it("chains a memory store in front of a Redis store for the default chain", () => {
    setCaches({ default: ["memory", "shared"], stores: { shared } });

    expect(buildCacheStore("op", { ttl: 1_000, max: 10 })).toBeInstanceOf(TieredCacheStore);
  });

  it("reads the operation's own stores over the default chain", () => {
    setCaches({ default: ["memory", "shared"], stores: { shared } });

    expect(buildCacheStore("op", { max: 10, stores: ["memory"] })).toBeInstanceOf(LruCacheStore);
  });
});

describe("buildCacheStore memory ttl", () => {
  const timed = (ttl: number | undefined, url = shared.url) => ({
    type: "redis" as const,
    url,
    ...(ttl === undefined ? {} : { ttl }),
  });
  // A Redis that never answers would hold a read of the expired entry, so the memory tier is read alone.
  const served = async (store: CacheStore) => {
    const [memory]: CacheStore[] = Reflect.get(store, "stores");
    await memory!.set("k", "v");
    await Bun.sleep(60);
    return memory!.get("k");
  };

  it("expires the memory copy with the Redis store's ttl when the operation sets none", async () => {
    setCaches({ default: ["memory", "shared"], stores: { shared: timed(20) } });

    expect(await served(buildCacheStore("op", { max: 10 }))).toBeUndefined();
  });

  it("takes the smallest ttl among the Redis stores that set one", async () => {
    setCaches({
      default: ["memory", "slow", "none", "quick"],
      stores: {
        slow: timed(60_000),
        none: timed(undefined, "redis://127.0.0.1:6393"),
        quick: timed(20, "redis://127.0.0.1:6394"),
      },
    });

    expect(await served(buildCacheStore("op", { max: 10 }))).toBeUndefined();
  });

  it("keeps the operation's own ttl over the Redis store's", async () => {
    setCaches({ default: ["memory", "shared"], stores: { shared: timed(20) } });

    expect(await served(buildCacheStore("op", { max: 10, ttl: 60_000 }))).toBe("v");
  });

  it("gives the memory copy no ttl when no Redis store sets one", async () => {
    setCaches({ default: ["memory", "shared"], stores: { shared: timed(undefined) } });

    expect(await served(buildCacheStore("op", { max: 10 }))).toBe("v");
  });
});

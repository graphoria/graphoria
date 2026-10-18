import { afterEach, describe, expect, it } from "bun:test";

import type { CacheStore } from "./types";

import { ConfigurationZod } from "../../types/zod/configuration";
import { LruCacheStore } from "./lruCacheStore";
import { RedisCacheStore } from "./redisCacheStore";
import { closeCacheRedisClient } from "./redisClient";
import { buildCacheStore, getCaches, redisStoreOf, setCaches, storesInUse } from "./stores";
import { TieredCacheStore } from "./tieredCacheStore";

// Nothing listens here, and no test sends these clients a command.
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

  it("keys a Redis store's entries under its prefix", () => {
    setCaches({ default: ["shared"], stores: { shared: { ...shared, prefix: "app1" } } });

    expect(Reflect.get(buildCacheStore("op", { ttl: 1_000 }), "prefix")).toBe("app1:cache:op:");
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
  // The memory tier is read alone: nothing listens at the Redis URL.
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

describe("redisStoreOf", () => {
  const declared = {
    default: ["memory"],
    stores: {
      shared,
      prefixed: { ...shared, prefix: "app1" },
      trailing: { ...shared, prefix: "app1::" },
    },
  };

  it("reads the URL of a declared store, with no key prefix when it sets none", () => {
    expect(redisStoreOf(declared, "AUTH_STORE", "shared")).toEqual({ url: shared.url, prefix: "" });
  });

  it("ends the key prefix with one colon, however many the store's prefix ends with", () => {
    expect(redisStoreOf(declared, "AUTH_STORE", "prefixed").prefix).toBe("app1:");
    expect(redisStoreOf(declared, "AUTH_STORE", "trailing").prefix).toBe("app1:");
  });

  it("names the variable and the store it lacks", () => {
    expect(() => redisStoreOf(declared, "RATE_LIMIT_STORE", "nope")).toThrow(
      "RATE_LIMIT_STORE=nope names no store: declare it in caches.stores, or set RATE_LIMIT_STORE=memory",
    );
  });

  it("finds no store among the names Object.prototype lends", () => {
    expect(() => redisStoreOf(declared, "AUTH_STORE", "toString")).toThrow(
      "AUTH_STORE=toString names no store",
    );
  });
});

describe("storesInUse", () => {
  const tokens = { type: "redis" as const, url: "redis://127.0.0.1:6394" };
  const configuration = (operations: Record<string, unknown>) =>
    ConfigurationZod.parse({
      name: "t",
      version: "1",
      caches: { default: ["memory", "shared"], stores: { shared, tokens } },
      operations,
    });

  const rest = { path: "/list", method: "GET" };

  it("lists the default chain's stores only while a cached REST operation reads it", () => {
    expect(storesInUse(configuration({}), undefined, undefined)).toEqual([]);
    expect(
      storesInUse(
        configuration({ list: { query: "{ ping }", rest, cache: { ttl: 1_000 } } }),
        undefined,
        undefined,
      ),
    ).toEqual(["shared"]);
  });

  it("skips a cached operation that has no REST route, which gets no store", () => {
    const operations = { list: { query: "{ ping }", cache: { ttl: 1_000 } } };

    expect(storesInUse(configuration(operations), undefined, undefined)).toEqual([]);
  });

  it("lists an operation's own stores", () => {
    const operations = {
      list: { query: "{ ping }", rest, cache: { ttl: 1_000, stores: ["tokens"] } },
    };

    expect(storesInUse(configuration(operations), undefined, undefined)).toEqual(["tokens"]);
  });

  it("adds the stores the token store and the rate limiter name, never memory", () => {
    expect(storesInUse(configuration({}), "tokens", "shared")).toEqual(["tokens", "shared"]);
    expect(storesInUse(configuration({}), "memory", "memory")).toEqual([]);
  });
});

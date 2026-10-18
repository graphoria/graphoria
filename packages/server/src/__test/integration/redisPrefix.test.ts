import { beforeAll, describe, expect, it } from "bun:test";

import type { getCacheRedisClient } from "../../singletons/cache/redisClient";

import { REDIS_URL } from "./config";
import { integrationEnabled } from "./harness";

/**
 * Two deployments on one Redis, told apart by their stores' prefixes alone:
 * neither reads the other's cached entries or token records. Their rate-limit
 * buckets are in rateLimit.test.ts, with the servers that keep them.
 */
describe.skipIf(!integrationEnabled)("two prefixes on one Redis", () => {
  // New for each run, so nothing an earlier run left is read here.
  const one = `one-${crypto.randomUUID()}`;
  const two = `two-${crypto.randomUUID()}`;
  const caches = {
    default: ["memory"],
    stores: {
      one: { type: "redis" as const, url: REDIS_URL, prefix: one },
      two: { type: "redis" as const, url: REDIS_URL, prefix: two },
    },
  };

  let cache: typeof import("../../singletons/cache");
  let tokens: typeof import("../../authentication/tokenRepository");
  let client: ReturnType<typeof getCacheRedisClient>;

  // `singletons/cache` loads the logger, which reads LOG_LEVEL once, at load; the
  // harness import sets it first.
  beforeAll(async () => {
    cache = await import("../../singletons/cache");
    tokens = await import("../../authentication/tokenRepository");
    const { CACHE_REDIS_POOL_SIZE, getCacheRedisClient } =
      await import("../../singletons/cache/redisClient");
    // A fresh client fails a command until its connection is up, so connect the
    // whole pool the stores below draw from.
    await Promise.all(
      Array.from({ length: CACHE_REDIS_POOL_SIZE }, () => getCacheRedisClient(REDIS_URL).connect()),
    );
    client = getCacheRedisClient(REDIS_URL);
  });

  it("serves neither prefix's cached entries to the other", async () => {
    cache.setCaches(caches);
    const first = cache.buildCacheStore("list", { ttl: 60_000, stores: ["one"] });
    const second = cache.buildCacheStore("list", { ttl: 60_000, stores: ["two"] });
    const entry = `cache:list:${Bun.hash("k").toString(36)}`;

    try {
      await first.set("k", "one's rows");
      expect(await second.get("k")).toBeUndefined();

      await second.set("k", "two's rows");
      expect(await first.get("k")).toBe("one's rows");
      expect(await client.get(`${one}:${entry}`)).toBe("one's rows");
      expect(await client.smembers(`${one}:cache:list:__keys`)).toEqual(["k"]);

      await first.clear();
      expect(await first.get("k")).toBeUndefined();
      expect(await second.get("k")).toBe("two's rows");
    } finally {
      await first.clear();
      await second.clear();
      cache.setCaches(null);
    }
  });

  it("records a revocation under one prefix only", async () => {
    const first = tokens.createConfiguredTokenRepository(true, "one", caches);
    const second = tokens.createConfiguredTokenRepository(true, "two", caches);
    const jti = crypto.randomUUID();

    try {
      // Fresh clients are still connecting; the store waits for them.
      await first.revoke(jti, "1m");

      expect(await first.isRevoked(jti)).toBe(true);
      expect(await second.isRevoked(jti)).toBe(false);
      expect(await client.hmget(`${one}:${jti}`, ["isRevoked"])).toEqual(["true"]);
      expect(await client.exists(jti)).toBe(false);
    } finally {
      first.close();
      second.close();
    }
  });
});

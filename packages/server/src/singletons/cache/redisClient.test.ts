import { describe, expect, it } from "bun:test";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const { CACHE_REDIS_POOL_SIZE, closeCacheRedisClient, getCacheRedisClient } =
  await import("./redisClient");

describe("getCacheRedisClient", () => {
  it("round-robins a fixed-size pool of clients", () => {
    const first = getCacheRedisClient();
    const rest = Array.from({ length: CACHE_REDIS_POOL_SIZE - 1 }, () => getCacheRedisClient());

    expect(new Set([first, ...rest]).size).toBe(CACHE_REDIS_POOL_SIZE);
    expect(getCacheRedisClient()).toBe(first);
    closeCacheRedisClient();
  });

  it("recreates the whole pool after close", () => {
    const first = getCacheRedisClient();

    closeCacheRedisClient();

    expect(getCacheRedisClient()).not.toBe(first);
    closeCacheRedisClient();
  });
});

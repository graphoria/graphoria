import { describe, expect, it } from "bun:test";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const { closeCacheRedisClient, getCacheRedisClient } = await import("./redisClient");

describe("closeCacheRedisClient", () => {
  it("drops the closed client, so the next get builds a new one", () => {
    const first = getCacheRedisClient();

    closeCacheRedisClient();

    expect(getCacheRedisClient()).not.toBe(first);
    closeCacheRedisClient();
  });
});

import { describe, expect, it } from "bun:test";

import { CACHE_REDIS_POOL_SIZE, closeCacheRedisClient, getCacheRedisClient } from "./redisClient";

// Nothing listens here, and no test sends these clients a command.
const FIRST_URL = "redis://127.0.0.1:6390";
const SECOND_URL = "redis://127.0.0.1:6391";

describe("getCacheRedisClient", () => {
  it("round-robins a fixed-size pool of clients for a URL", () => {
    const first = getCacheRedisClient(FIRST_URL);
    const rest = Array.from({ length: CACHE_REDIS_POOL_SIZE - 1 }, () =>
      getCacheRedisClient(FIRST_URL),
    );

    expect(new Set([first, ...rest]).size).toBe(CACHE_REDIS_POOL_SIZE);
    expect(getCacheRedisClient(FIRST_URL)).toBe(first);
    closeCacheRedisClient();
  });

  it("keeps a separate pool for each URL", () => {
    const first = getCacheRedisClient(FIRST_URL);
    const second = Array.from({ length: CACHE_REDIS_POOL_SIZE }, () =>
      getCacheRedisClient(SECOND_URL),
    );

    expect(second).not.toContain(first);
    closeCacheRedisClient();
  });

  it("recreates every pool after close", () => {
    const wholePool = (url: string) =>
      Array.from({ length: CACHE_REDIS_POOL_SIZE }, () => getCacheRedisClient(url));
    const before = [...wholePool(FIRST_URL), ...wholePool(SECOND_URL)];

    closeCacheRedisClient();

    const after = [...wholePool(FIRST_URL), ...wholePool(SECOND_URL)];
    expect(after.some((client) => before.includes(client))).toBe(false);
    closeCacheRedisClient();
  });
});

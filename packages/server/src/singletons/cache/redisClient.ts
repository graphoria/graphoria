import { closeRedisClient, createRedisClient } from "../../utils/redis";

export const CACHE_REDIS_POOL_SIZE = 4;

type Pool = { clients: ReturnType<typeof createRedisClient>[]; next: number };

// One socket serializes all in-flight commands, capping p99 latency. Each
// store captures its client at construction, so per-store command ordering
// (untrack before delete) survives the round-robin across stores.
const pools = new Map<string, Pool>();

export const getCacheRedisClient = (url: string): ReturnType<typeof createRedisClient> => {
  let pool = pools.get(url);
  if (!pool) {
    pool = {
      clients: Array.from({ length: CACHE_REDIS_POOL_SIZE }, () => createRedisClient(url)),
      next: 0,
    };
    pools.set(url, pool);
  }
  return pool.clients[pool.next++ % CACHE_REDIS_POOL_SIZE]!;
};

export const closeCacheRedisClient = () => {
  for (const pool of pools.values()) {
    for (const client of pool.clients) closeRedisClient(client);
  }
  pools.clear();
};

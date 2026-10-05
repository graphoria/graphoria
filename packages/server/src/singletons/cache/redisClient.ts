import { env } from "../env";
import { closeRedisClient, createRedisClient } from "../../utils/redis";

export const CACHE_REDIS_POOL_SIZE = 4;

// One socket serializes all in-flight commands, capping p99 latency. Each
// store captures its client at construction, so per-store command ordering
// (untrack before delete) survives the round-robin across stores.
let clients: ReturnType<typeof createRedisClient>[] | null = null;
let next = 0;

export const getCacheRedisClient = (): ReturnType<typeof createRedisClient> => {
  if (!clients) {
    clients = Array.from({ length: CACHE_REDIS_POOL_SIZE }, () =>
      createRedisClient(env.cache.redisUrl),
    );
    next = 0;
  }
  return clients[next++ % CACHE_REDIS_POOL_SIZE]!;
};

export const closeCacheRedisClient = () => {
  if (!clients) return;
  for (const pooled of clients) closeRedisClient(pooled);
  clients = null;
};

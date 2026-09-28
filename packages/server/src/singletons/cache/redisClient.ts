import { env } from "../env";
import { closeRedisClient, createRedisClient } from "../../utils/redis";

let client: ReturnType<typeof createRedisClient> | null = null;

export const getCacheRedisClient = (): ReturnType<typeof createRedisClient> => {
  if (!client) {
    client = createRedisClient(env.cache.redisUrl);
  }
  return client;
};

export const closeCacheRedisClient = () => {
  if (!client) return;
  closeRedisClient(client);
  client = null;
};

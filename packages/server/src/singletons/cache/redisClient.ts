import { env } from "../env";
import { createRedisClient } from "../../utils/redis";

let client: ReturnType<typeof createRedisClient> | null = null;

export const getCacheRedisClient = (): ReturnType<typeof createRedisClient> => {
  if (!client) {
    client = createRedisClient(env.cache.redisUrl);
  }
  return client;
};

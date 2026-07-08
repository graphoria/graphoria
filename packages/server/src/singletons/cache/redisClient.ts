import { RedisClient as ValkeyClient } from "bun";

import { env } from "../env";

let client: InstanceType<typeof ValkeyClient> | null = null;

export const getCacheRedisClient = (): InstanceType<typeof ValkeyClient> => {
  if (!client) {
    client = new ValkeyClient(env.cache.redisUrl);
  }
  return client;
};

import type { CacheStore } from "./types";

import { getCacheRedisClient } from "./redisClient";
import { logger } from "../../logging";

export class RedisCacheStore implements CacheStore {
  private prefix: string;
  private trackingKey: string;
  private ttlSeconds: number | undefined;
  private client: ReturnType<typeof getCacheRedisClient>;
  private log = logger("redis-cache");

  constructor(operationName: string, ttlMs?: number) {
    this.prefix = `cache:${operationName}:`;
    this.trackingKey = `${this.prefix}__keys`;
    this.ttlSeconds = ttlMs ? Math.ceil(ttlMs / 1000) : undefined;
    this.client = getCacheRedisClient();
  }

  private fullKey(key: string): string {
    const hash = Bun.hash(key).toString(36);
    return `${this.prefix}${hash}`;
  }

  async get(key: string): Promise<unknown | undefined> {
    try {
      const raw = await this.client.get(this.fullKey(key));
      if (raw === null) return undefined;
      return JSON.parse(raw);
    } catch (error) {
      this.log.error({ err: error, operation: "get" }, "cache get failed");
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      const redisKey = this.fullKey(key);
      await this.client.set(redisKey, JSON.stringify(value));
      if (this.ttlSeconds) {
        await this.client.expire(redisKey, this.ttlSeconds);
      }
      await this.client.sadd(this.trackingKey, key);
    } catch (error) {
      this.log.error({ err: error, operation: "set" }, "cache set failed");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(this.fullKey(key));
      await this.client.srem(this.trackingKey, key);
    } catch (error) {
      this.log.error({ err: error, operation: "delete" }, "cache delete failed");
    }
  }

  async clear(): Promise<void> {
    try {
      const originalKeys = await this.client.smembers(this.trackingKey);
      if (originalKeys.length > 0) {
        const redisKeys = originalKeys.map((k: string) => this.fullKey(k));
        for (const redisKey of redisKeys) {
          await this.client.del(redisKey);
        }
      }
      await this.client.del(this.trackingKey);
    } catch (error) {
      this.log.error({ err: error, operation: "clear" }, "cache clear failed");
    }
  }

  async keys(): Promise<string[]> {
    try {
      return await this.client.smembers(this.trackingKey);
    } catch (error) {
      this.log.error({ err: error, operation: "keys" }, "cache keys failed");
      return [];
    }
  }
}

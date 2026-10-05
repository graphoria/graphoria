import { LRUCache } from "lru-cache";

import type { CacheStore } from "./types";

export class LruCacheStore implements CacheStore {
  private cache: LRUCache<string, string>;

  constructor(options: LRUCache.Options<string, string, unknown>) {
    this.cache = new LRUCache(options);
  }

  async get(key: string): Promise<string | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  async keys(): Promise<string[]> {
    return [...this.cache.keys()];
  }
}

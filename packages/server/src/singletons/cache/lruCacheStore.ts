import { LRUCache } from "lru-cache";

import type { CacheStore } from "./types";

// oxlint-disable-next-line typescript/no-explicit-any
export class LruCacheStore implements CacheStore {
  // oxlint-disable-next-line typescript/no-explicit-any
  private cache: LRUCache<string, any>;

  // oxlint-disable-next-line typescript/no-explicit-any
  constructor(options: LRUCache.Options<string, any, unknown>) {
    this.cache = new LRUCache(options);
  }

  async get(key: string): Promise<unknown | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
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

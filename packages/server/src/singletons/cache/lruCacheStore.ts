import { LRUCache } from "lru-cache";

import type { CacheStore } from "./types";

export class LruCacheStore implements CacheStore {
  private cache: LRUCache<string, string>;
  // Companion entries holding the ETag computed at write time, so a hit serves
  // it without re-hashing the body. Same options as `cache` so the two evict
  // and expire together; entries without an etag simply miss this map.
  private etags: LRUCache<string, string>;

  constructor(options: LRUCache.Options<string, string, unknown>) {
    this.cache = new LRUCache(options);
    this.etags = new LRUCache(options);
  }

  async get(key: string): Promise<string | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
    // A caller that stored without an etag invalidates any stale one.
    this.etags.delete(key);
  }

  async getWithEtag(key: string): Promise<{ value: string; etag?: string } | undefined> {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    return { value, etag: this.etags.get(key) };
  }

  async setWithEtag(key: string, value: string, etag: string): Promise<void> {
    this.cache.set(key, value);
    this.etags.set(key, etag);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    this.etags.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.etags.clear();
  }

  async keys(): Promise<string[]> {
    return [...this.cache.keys()];
  }
}

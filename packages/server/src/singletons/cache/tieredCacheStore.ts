import type { CacheStore } from "./types";

import { logger } from "../../logging";

type Entry = { value: string; etag?: string };

const write = (store: CacheStore, key: string, value: string, etag?: string): Promise<void> =>
  etag !== undefined && store.setWithEtag
    ? store.setWithEtag(key, value, etag)
    : store.set(key, value);

/**
 * Reads its stores in order and serves the first hit; writes, deletes and
 * clears reach every store. A store that throws is logged and skipped, so a
 * cache fault never fails a request.
 */
export class TieredCacheStore implements CacheStore {
  private log = logger("tiered-cache");

  /** `names[i]` is the configured name of `stores[i]`; the logs carry it. */
  constructor(
    private readonly stores: CacheStore[],
    private readonly names: string[],
  ) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.getWithEtag(key))?.value;
  }

  async getWithEtag(key: string): Promise<Entry | undefined> {
    for (const [tier, store] of this.stores.entries()) {
      const entry = await this.read(store, tier, key);
      if (entry === undefined) continue;
      // Upward only: copying a hit into the stores after it would put back an
      // entry they dropped, expired or invalidated from another process.
      if (tier > 0) {
        void this.each("promote", this.stores.slice(0, tier), (above) =>
          write(above, key, entry.value, entry.etag),
        );
      }
      return entry;
    }
    return undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.each("set", this.stores, (store) => store.set(key, value));
  }

  async setWithEtag(key: string, value: string, etag: string): Promise<void> {
    await this.each("setWithEtag", this.stores, (store) => write(store, key, value, etag));
  }

  async delete(key: string): Promise<void> {
    await this.each("delete", this.stores, (store) => store.delete(key));
  }

  async clear(): Promise<void> {
    await this.each("clear", this.stores, (store) => store.clear());
  }

  async keys(): Promise<string[]> {
    const keys = new Set<string>();
    await this.each("keys", this.stores, async (store) => {
      for (const key of await store.keys()) keys.add(key);
    });
    return [...keys];
  }

  private async read(store: CacheStore, tier: number, key: string): Promise<Entry | undefined> {
    try {
      if (store.getWithEtag) return await store.getWithEtag(key);
      const value = await store.get(key);
      return value === undefined ? undefined : { value };
    } catch (error) {
      this.log.error(
        { err: error, store: this.names[tier], operation: "get" },
        "cache tier failed",
      );
      return undefined;
    }
  }

  /** `stores` is always a prefix of the chain, so an index into it names its store. */
  private async each(
    operation: string,
    stores: CacheStore[],
    run: (store: CacheStore) => Promise<void>,
  ) {
    const results = await Promise.allSettled(stores.map(async (store) => run(store)));
    for (const [tier, result] of results.entries()) {
      if (result.status === "rejected") {
        this.log.error(
          { err: result.reason, store: this.names[tier], operation },
          "cache tier failed",
        );
      }
    }
  }
}

import type { LRUCache } from "lru-cache";
import type { CacheStore } from "./types";
import type { OperationCacheConfig } from "../../config/types/operation";
import type { Configuration } from "../../types/configuration";

import { MEMORY_STORE } from "../../config/types/cache";
import { LruCacheStore } from "./lruCacheStore";
import { RedisCacheStore } from "./redisCacheStore";
import { TieredCacheStore } from "./tieredCacheStore";

type Caches = Configuration["caches"];
type LruOptions = LRUCache.Options<string, string, unknown>;

const NO_CACHES: Caches = { default: [MEMORY_STORE], stores: {} };

let caches: Caches = NO_CACHES;

/** Set from the parsed configuration before routes are built; `null` restores the default. */
export const setCaches = (value: Caches | null) => {
  caches = value ?? NO_CACHES;
};

export const getCaches = (): Caches => caches;

const lruOptions = (cache: OperationCacheConfig, ttl: number | undefined): LruOptions => {
  const options: Partial<LruOptions> = {
    updateAgeOnHas: cache.updateAgeOnHas ?? false,
    ttlAutopurge: cache.ttlAutopurge ?? true,
  };

  if (cache.max) options.max = cache.max;
  if (cache.maxSize) {
    options.maxSize = cache.maxSize;
    // lru-cache needs every entry's size once maxSize is set. An entry is
    // the response's JSON text, so its size is the text's length.
    options.sizeCalculation = (value: string) => value.length;
  }
  if (ttl) options.ttl = ttl;
  if (cache.allowStale !== undefined) options.allowStale = cache.allowStale;
  if (cache.updateAgeOnGet !== undefined) options.updateAgeOnGet = cache.updateAgeOnGet;

  // LRUCache.Options requires at least one of max/maxSize/ttl; the
  // configuration check guarantees one, and the cast bridges the structural gap.
  return options as LruOptions;
};

/** The URL of the Redis store an env variable names; throws when caches.stores lacks it. */
export const redisUrlOf = (declared: Caches, variable: string, name: string): string => {
  const store = Object.hasOwn(declared.stores, name) ? declared.stores[name] : undefined;
  if (!store) {
    throw new Error(
      `${variable}=${name} names no store: declare it in caches.stores, or set ${variable}=${MEMORY_STORE}`,
    );
  }
  return store.url;
};

/** The store an operation's responses are kept in: its own `stores`, else the default chain. */
export const buildCacheStore = (operationName: string, cache: OperationCacheConfig): CacheStore => {
  const chain = cache.stores ?? caches.default;
  // Without its own ttl the memory copy expires with the soonest Redis store's
  // fallback: with no ttl at all, it would outlive every Redis expiry.
  const memoryTtl =
    cache.ttl ??
    chain
      .map((name) => caches.stores[name]?.ttl)
      .reduce<number | undefined>(
        (soonest, ttl) =>
          ttl === undefined || (soonest !== undefined && soonest <= ttl) ? soonest : ttl,
        undefined,
      );

  const stores = chain.map((name): CacheStore => {
    if (name === MEMORY_STORE) return new LruCacheStore(lruOptions(cache, memoryTtl));
    const store = caches.stores[name]!;
    return new RedisCacheStore(operationName, store.url, cache.ttl ?? store.ttl);
  });

  // A one-store chain keeps its bare store, so it runs exactly the code it ran before chains.
  return stores.length === 1 ? stores[0]! : new TieredCacheStore(stores, chain);
};

/**
 * The declared stores something reads: a cached REST operation's chain, the token
 * store, or the rate limiter's. The in-process store is never listed.
 */
export const storesInUse = (
  configuration: Configuration,
  authStore: string | undefined,
  rateLimitStore: string | undefined,
): string[] => {
  const used = new Set<string>();
  for (const { cache, rest } of Object.values(configuration.operations)) {
    // Only REST operations are built, so a cache on one without `rest` reads no store.
    if (!cache || !rest) continue;
    for (const name of cache.stores ?? configuration.caches.default) used.add(name);
  }
  if (authStore !== undefined) used.add(authStore);
  if (rateLimitStore !== undefined) used.add(rateLimitStore);
  used.delete(MEMORY_STORE);
  return [...used];
};

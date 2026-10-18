import type { z } from "zod";

import type { CachesZod } from "../../config/types/cache";
import type { OperationCacheConfig } from "../../config/types/operation";

import { MEMORY_STORE, keyPrefixOf } from "../../config/types/cache";

type Caches = z.output<typeof CachesZod>;

type CacheIssue = { path: (string | number)[]; message: string };

// The operation fields only the in-process LRU reads; `ttl` reaches every store.
const MEMORY_FIELDS = [
  "max",
  "maxSize",
  "allowStale",
  "updateAgeOnGet",
  "updateAgeOnHas",
  "ttlAutopurge",
] as const;

const chainIssues = (chain: string[], caches: Caches, path: (string | number)[]): CacheIssue[] => {
  const issues: CacheIssue[] = [];
  const storeByKeys = new Map<string, string>();

  for (const [index, name] of chain.entries()) {
    const at = [...path, index];
    if (chain.indexOf(name) !== index) {
      issues.push({ path: at, message: `cache store "${name}" is listed twice` });
      continue;
    }
    if (name === MEMORY_STORE) continue;

    const store = Object.hasOwn(caches.stores, name) ? caches.stores[name] : undefined;
    if (!store) {
      issues.push({
        path: at,
        message: `unknown cache store "${name}": declare it in caches.stores, or use "${MEMORY_STORE}"`,
      });
      continue;
    }

    // A prefix holds no space, so no two URL and prefix pairs join into one string.
    const keys = `${store.url} ${keyPrefixOf(store)}`;
    const twin = storeByKeys.get(keys);
    if (twin === undefined) {
      storeByKeys.set(keys, name);
    } else {
      issues.push({
        path: at,
        message: `cache stores "${twin}" and "${name}" use the same Redis URL and prefix, so their entries would share keys`,
      });
    }
  }

  return issues;
};

/** The checks between `caches` and the operations that read it, which no single field can make. */
export const cacheIssues = (data: {
  caches: Caches;
  operations: Record<string, { cache?: OperationCacheConfig }>;
}): CacheIssue[] => {
  const issues: CacheIssue[] = [];

  if (MEMORY_STORE in data.caches.stores) {
    issues.push({
      path: ["caches", "stores", MEMORY_STORE],
      message: `"${MEMORY_STORE}" is the built-in in-process store and cannot be declared`,
    });
  }
  issues.push(...chainIssues(data.caches.default, data.caches, ["caches", "default"]));

  for (const [name, { cache }] of Object.entries(data.operations)) {
    if (!cache) continue;
    const path = ["operations", name, "cache"];
    if (cache.stores) issues.push(...chainIssues(cache.stores, data.caches, [...path, "stores"]));

    const chain = cache.stores ?? data.caches.default;
    if (chain.includes(MEMORY_STORE)) {
      if (cache.max === undefined && cache.maxSize === undefined && cache.ttl === undefined) {
        issues.push({ path, message: `the "${MEMORY_STORE}" store needs max, maxSize or ttl` });
      }
    } else {
      const ignored = MEMORY_FIELDS.filter((field) => cache[field] !== undefined);
      if (ignored.length > 0) {
        issues.push({
          path,
          message: `the "${MEMORY_STORE}" store is not in this operation's chain, so ${ignored.join(", ")} would be ignored`,
        });
      }
    }
  }

  return issues;
};

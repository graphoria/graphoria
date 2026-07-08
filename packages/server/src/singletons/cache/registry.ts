import type { CacheStore } from "./types";

const cacheRegistry = new Map<string, CacheStore>();

export const registerCache = (name: string, cache: CacheStore) => {
  cacheRegistry.set(name, cache);
};

export const getCache = (name: string): CacheStore | undefined => {
  return cacheRegistry.get(name);
};

export const InvalidationHelper = {
  invalidate: async (
    operationName: string,
    pattern?: Record<string, unknown>,
  ): Promise<boolean> => {
    const cache = cacheRegistry.get(operationName);
    if (!cache) {
      return false;
    }

    if (!pattern || Object.keys(pattern).length === 0) {
      await cache.clear();
      return true;
    }

    const allKeys = await cache.keys();
    for (const key of allKeys) {
      try {
        const parsedKey = JSON.parse(key);
        const cachedVariables = parsedKey.variables;

        let match = true;
        for (const [k, v] of Object.entries(pattern)) {
          if (cachedVariables[k] !== v) {
            match = false;
            break;
          }
        }

        if (match) {
          await cache.delete(key);
        }
      } catch {
        // Ignore parse errors
      }
    }
    return true;
  },
};

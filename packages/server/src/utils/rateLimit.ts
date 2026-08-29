import { LRUCache } from "lru-cache";

export type ConsumeResult = { allowed: boolean; retryAfterMs: number };

/**
 * One method, everything per call: a role with its own limit shares the store
 * with every other role rather than needing an instance of its own.
 */
export interface RateLimitStore {
  consume(
    key: string,
    capacity: number,
    refillPerMs: number,
    ttlMs: number,
  ): Promise<ConsumeResult>;
}

type Bucket = { tokens: number; ts: number };

export type MemoryRateLimitStoreOptions = {
  now?: () => number;
  maxKeys?: number;
};

const DEFAULT_MAX_KEYS = 10_000;

export const createMemoryRateLimitStore = ({
  now = Date.now,
  maxKeys = DEFAULT_MAX_KEYS,
}: MemoryRateLimitStoreOptions = {}): RateLimitStore => {
  // The bound is load-bearing: an unbounded map keyed by client address is
  // itself a memory-exhaustion vector. Evicting a bucket only ever gives its
  // owner a full one, which is what an idle caller would have had anyway.
  const buckets = new LRUCache<string, Bucket>({ max: maxKeys });

  return {
    consume: async (key, capacity, refillPerMs, ttlMs) => {
      const nowMs = now();
      const bucket = buckets.get(key);
      const tokens = bucket
        ? Math.min(capacity, bucket.tokens + (nowMs - bucket.ts) * refillPerMs)
        : capacity;

      if (tokens < 1) {
        buckets.set(key, { tokens, ts: nowMs }, { ttl: ttlMs });
        return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
      }

      buckets.set(key, { tokens: tokens - 1, ts: nowMs }, { ttl: ttlMs });
      return { allowed: true, retryAfterMs: 0 };
    },
  };
};

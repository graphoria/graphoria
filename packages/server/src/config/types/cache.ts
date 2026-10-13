import { z } from "zod";

/** The in-process LRU store, shaped by each operation's own cache fields. Never declared. */
export const MEMORY_STORE = "memory";

export const RedisCacheStoreConfigZod = z.strictObject({
  type: z.literal("redis"),
  /** Redis or Valkey URL, e.g. `redis://localhost:6379` */
  url: z.string().min(1),
  /** Entry lifetime in milliseconds for the operations that set no `ttl` */
  ttl: z.number().int().positive().optional(),
});

export const CacheStoreConfigZod = z.discriminatedUnion("type", [RedisCacheStoreConfigZod]);

export const CachesZod = z.strictObject({
  /** Stores every cached operation reads, fastest first, unless it lists its own `stores` */
  default: z
    .array(z.string())
    .min(1)
    .optional()
    .default(() => [MEMORY_STORE]),
  /** Named stores an operation, `AUTH_STORE` or `RATE_LIMIT_STORE` can point at */
  stores: z
    .record(z.string(), CacheStoreConfigZod)
    .optional()
    .default(() => ({})),
});

export type CacheStoreConfig = z.input<typeof CacheStoreConfigZod>;
export type CachesConfig = z.input<typeof CachesZod>;

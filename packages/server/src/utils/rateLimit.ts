import { LRUCache } from "lru-cache";

import { logger } from "../logging";

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

export type RateLimitRedisClient = {
  send(command: string, args: string[]): Promise<unknown>;
};

type RateLimitLogger = { warn(obj: object, msg: string): void };

export type RedisRateLimitStoreOptions = {
  now?: () => number;
  log?: RateLimitLogger;
};

// KEYS[1] = bucket key, ARGV = capacity, refillPerMs, nowMs, ttlMs. Refill,
// read and write have to happen inside Redis: doing them from here would race
// between workers, which is the whole reason for reaching for Redis at all.
const CONSUME_SCRIPT = `
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or tonumber(ARGV[1])
local ts = tonumber(b[2]) or tonumber(ARGV[3])
tokens = math.min(tonumber(ARGV[1]), tokens + (tonumber(ARGV[3]) - ts) * tonumber(ARGV[2]))
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return { allowed, tostring(tokens) }
`;

export const createRedisRateLimitStore = (
  client: RateLimitRedisClient,
  { now = Date.now, log = logger("rate-limit") }: RedisRateLimitStoreOptions = {},
): RateLimitStore => {
  let lastWarnMs: number | undefined;

  return {
    consume: async (key, capacity, refillPerMs, ttlMs) => {
      const nowMs = now();

      try {
        const reply = (await client.send("EVAL", [
          CONSUME_SCRIPT,
          "1",
          key,
          String(capacity),
          String(refillPerMs),
          String(nowMs),
          String(ttlMs),
        ])) as [number | string, string];

        const allowed = Number(reply[0]) === 1;
        const tokens = Number(reply[1]);

        return allowed
          ? { allowed: true, retryAfterMs: 0 }
          : { allowed: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
      } catch (error) {
        // A dead cache must not take the API down, and a dead cache must not
        // produce a log line per request either — the flood would outlast the
        // outage.
        if (lastWarnMs === undefined || nowMs - lastWarnMs >= ttlMs) {
          lastWarnMs = nowMs;
          log.warn({ err: error }, "rate limit store unavailable, allowing the request");
        }
        return { allowed: true, retryAfterMs: 0 };
      }
    },
  };
};

export type RateLimitSettings = {
  max: number;
  anonymousMax: number;
  windowMs: number;
  trustProxy: boolean;
};

type RoleRateLimit = { rateLimit?: { max: number; windowMs?: number } | undefined };

export type RateLimiter = {
  check(
    session: { role?: string | undefined; sub?: string | undefined } | null,
    address: string | undefined,
  ): Promise<ConsumeResult>;
};

export type CreateRateLimiterOptions = {
  settings: RateLimitSettings;
  anonymousRole: string;
  permissions?: Record<string, RoleRateLimit | undefined>;
  /** A factory is only called once a limit is configured, so a disabled
   * limiter never constructs a store — or a Redis client. */
  store?: RateLimitStore | (() => RateLimitStore);
};

// Attacker-controlled once RATE_LIMIT_TRUST_PROXY is on, and it ends up in a
// store key, so it is capped before it gets there.
const MAX_ADDRESS_LENGTH = 64;

export const resolveClientAddress = (
  req: Request,
  server: { requestIP(req: Request): { address: string } | null } | undefined,
  trustProxy: boolean,
): string | undefined => {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.slice(0, MAX_ADDRESS_LENGTH);
  }

  return server?.requestIP(req)?.address;
};

/**
 * `undefined` when nothing is configured, so the caller can skip the wrapper
 * entirely and the shipped default costs nothing per request.
 */
export const createRateLimiter = ({
  settings,
  anonymousRole,
  permissions = {},
  store,
}: CreateRateLimiterOptions): RateLimiter | undefined => {
  const configured =
    settings.max > 0 ||
    settings.anonymousMax > 0 ||
    Object.values(permissions).some((permission) => (permission?.rateLimit?.max ?? 0) > 0);

  if (!configured) return undefined;

  const resolvedStore =
    typeof store === "function" ? store() : (store ?? createMemoryRateLimitStore());

  const limitFor = (role: string) => {
    const roleLimit = permissions[role]?.rateLimit;

    return {
      max: roleLimit?.max ?? (role === anonymousRole ? settings.anonymousMax : settings.max),
      windowMs: roleLimit?.windowMs ?? settings.windowMs,
    };
  };

  return {
    check: async (session, address) => {
      const role = session?.role ?? anonymousRole;
      const { max, windowMs } = limitFor(role);

      if (max === 0) return { allowed: true, retryAfterMs: 0 };

      const sub = session?.sub;
      const key =
        sub && sub !== "anonymous" ? `rl:${role}:${sub}` : `rl:${role}:ip:${address ?? "unknown"}`;

      return resolvedStore.consume(key, max, max / windowMs, windowMs);
    },
  };
};

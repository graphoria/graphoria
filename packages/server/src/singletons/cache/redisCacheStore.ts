import type { CacheStore } from "./types";

import { getCacheRedisClient } from "./redisClient";
import { logger } from "../../logging";

// Entries removed per command when clearing.
const DELETE_BATCH = 1000;
// Due index members checked per script run, so that one run stays short.
const PRUNE_BATCH = 100;
// How often an entry without a TTL is checked for having been deleted.
const RECHECK_MS = 3_600_000;

// KEYS[1]: the set of cached keys. KEYS[2]: the sorted set of "<hash>:<key>"
// members, scored by when to check the entry next. ARGV[1]: the entry prefix.
// ARGV[2]: RECHECK_MS. ARGV[7]: whether to prune ("1"). To cache an entry,
// KEYS[3] is the entry and ARGV[3..6] its key, member, value and TTL in seconds
// ("" for none). Writing and tracking in one script means a Redis that refuses
// scripts caches nothing rather than entries no invalidation can find. A due
// member is untracked only once its entry is gone: a worker of an older version
// may have cached it again.
const SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
if KEYS[3] then
  if ARGV[6] ~= '' then
    redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[6])
    redis.call('ZADD', KEYS[2], now + ARGV[6] * 1000, ARGV[4])
  else
    redis.call('SET', KEYS[3], ARGV[5])
    redis.call('ZADD', KEYS[2], now + ARGV[2], ARGV[4])
  end
  redis.call('SADD', KEYS[1], ARGV[3])
end
local due
if ARGV[7] == '1' then
  due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, ${PRUNE_BATCH})
  for _, member in ipairs(due) do
    local separator = string.find(member, ':', 1, true)
    local ttl = redis.call('PTTL', ARGV[1] .. string.sub(member, 1, separator - 1))
    if ttl == -2 then
      redis.call('ZREM', KEYS[2], member)
      redis.call('SREM', KEYS[1], string.sub(member, separator + 1))
    elseif ttl == -1 then
      redis.call('ZADD', KEYS[2], now + ARGV[2], member)
    else
      redis.call('ZADD', KEYS[2], now + ttl, member)
    end
  end
end
return ARGV[7] == '1' and #due or 0
`;

export class RedisCacheStore implements CacheStore {
  private prefix: string;
  // The set older versions also read and write, so workers of both versions see
  // every entry during a rolling upgrade.
  private trackingKey: string;
  // When to check each tracked entry next, so keys of expired entries leave the
  // set instead of piling up.
  private expiryKey: string;
  private ttlSeconds: number | undefined;
  // How often an entry write may prune; the check costs a ZRANGEBYSCORE per run.
  private pruneIntervalMs: number;
  private lastPruneAt = 0;
  private client: ReturnType<typeof getCacheRedisClient>;
  private log = logger("redis-cache");

  constructor(operationName: string, ttlMs?: number, pruneIntervalMs = 1_000) {
    this.prefix = `cache:${operationName}:`;
    this.trackingKey = `${this.prefix}__keys`;
    this.expiryKey = `${this.prefix}__expiry`;
    this.ttlSeconds = ttlMs ? Math.ceil(ttlMs / 1000) : undefined;
    this.pruneIntervalMs = pruneIntervalMs;
    this.client = getCacheRedisClient();
  }

  // The entry key is a 64-bit Bun.hash; a collision would serve another
  // request's cached data, which is acceptable at current key counts but not
  // if a cache ever approaches billions of keys.
  private hash(key: string): string {
    return Bun.hash(key).toString(36);
  }

  private fullKey(key: string, hash: string): string {
    return `${this.prefix}${hash}`;
  }

  private member(key: string, hash: string): string {
    return `${hash}:${key}`;
  }

  private runScript(entry?: { key: string; value: string }) {
    const keys = [this.trackingKey, this.expiryKey];
    const args = [this.prefix, String(RECHECK_MS)];
    if (entry) {
      const now = Date.now();
      const pruning = now - this.lastPruneAt >= this.pruneIntervalMs;
      if (pruning) this.lastPruneAt = now;
      const hash = this.hash(entry.key);
      keys.push(this.fullKey(entry.key, hash));
      args.push(
        entry.key,
        this.member(entry.key, hash),
        entry.value,
        this.ttlSeconds ? String(this.ttlSeconds) : "",
        pruning ? "1" : "0",
      );
    } else {
      args.push("", "", "", "", "1");
    }
    return this.client.send("EVAL", [SCRIPT, String(keys.length), ...keys, ...args]);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const hash = this.hash(key);
      const raw = await this.client.get(this.fullKey(key, hash));
      if (raw === null) return undefined;
      return raw;
    } catch (error) {
      this.log.error({ err: error, operation: "get" }, "cache get failed");
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.runScript({ key, value });
    } catch (error) {
      this.log.error({ err: error, operation: "set" }, "cache set failed");
    }
  }

  // Untracked before deleted, in that order on the connection: an entry cached
  // between the two is deleted while still tracked, never left live untracked.
  async delete(key: string): Promise<void> {
    try {
      const hash = this.hash(key);
      await Promise.all([
        this.client.zrem(this.expiryKey, this.member(key, hash)),
        this.client.srem(this.trackingKey, key),
        this.client.del(this.fullKey(key, hash)),
      ]);
    } catch (error) {
      this.log.error({ err: error, operation: "delete" }, "cache delete failed");
    }
  }

  async clear(): Promise<void> {
    try {
      // Cursor scans, not bulk reads: the tracking set stays in Redis and each
      // batch is deleted before the next cursor step. Entries added mid-scan
      // either come up in a later cursor step (and are removed) or stay
      // tracked with their entry live — both consistent.
      let cursor = "0";
      do {
        const [next, batch] = await this.client.sscan(
          this.trackingKey,
          cursor,
          "COUNT",
          DELETE_BATCH,
        );
        if (batch.length > 0) {
          const hashes = batch.map((key) => this.hash(key));
          const [first, ...rest] = batch;
          const [firstMember, ...restMembers] = batch.map((key, index) =>
            this.member(key, hashes[index]!),
          );
          await Promise.all([
            this.client.zrem(this.expiryKey, firstMember!, ...restMembers),
            this.client.srem(this.trackingKey, first!, ...rest),
            this.client.unlink(...batch.map((key, index) => this.fullKey(key, hashes[index]!))),
          ]);
        }
        cursor = next;
      } while (cursor !== "0");

      // Members whose key left the set without them (an older version's
      // clear): zscan returns member/score pairs, so take every other element.
      cursor = "0";
      do {
        const [next, pairs] = await this.client.zscan(
          this.expiryKey,
          cursor,
          "COUNT",
          String(DELETE_BATCH),
        );
        const members = pairs.filter((_, index) => index % 2 === 0);
        if (members.length > 0) {
          const [first, ...rest] = members;
          // The member carries its hash ("<hash>:<key>"), so no re-hash here.
          const keys = members.map((member) => member.slice(member.indexOf(":") + 1));
          const hashes = members.map((member) => member.slice(0, member.indexOf(":")));
          await Promise.all([
            this.client.zrem(this.expiryKey, first!, ...rest),
            this.client.srem(this.trackingKey, keys[0]!, ...keys.slice(1)),
            this.client.unlink(...keys.map((key, index) => this.fullKey(key, hashes[index]!))),
          ]);
        }
        cursor = next;
      } while (cursor !== "0");
    } catch (error) {
      this.log.error({ err: error, operation: "clear" }, "cache clear failed");
    }
  }

  async keys(): Promise<string[]> {
    try {
      const [, keys] = await Promise.all([
        this.runScript(),
        (async () => {
          const found: string[] = [];
          let cursor = "0";
          do {
            const [next, batch] = await this.client.sscan(
              this.trackingKey,
              cursor,
              "COUNT",
              DELETE_BATCH,
            );
            found.push(...batch);
            cursor = next;
          } while (cursor !== "0");
          return found;
        })(),
      ]);
      return keys;
    } catch (error) {
      this.log.error({ err: error, operation: "keys" }, "cache keys failed");
      return [];
    }
  }
}

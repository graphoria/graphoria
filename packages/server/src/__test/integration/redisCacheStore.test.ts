import { afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { RedisCacheStore as RedisCacheStoreType } from "../../singletons/cache";
import type { getCacheRedisClient } from "../../singletons/cache/redisClient";

import { integrationEnabled } from "./harness";

describe.skipIf(!integrationEnabled)("RedisCacheStore", () => {
  let RedisCacheStore: typeof RedisCacheStoreType;
  let client: ReturnType<typeof getCacheRedisClient>;
  const created: RedisCacheStoreType[] = [];

  // `singletons/cache` parses the env at load; the harness import sets it first.
  beforeAll(async () => {
    ({ RedisCacheStore } = await import("../../singletons/cache"));
    client = (await import("../../singletons/cache/redisClient")).getCacheRedisClient();
  });

  afterEach(async () => {
    await Promise.all(created.splice(0).map((store) => store.clear()));
  });

  const store = (name: string, ttlMs?: number, pruneIntervalMs?: number) => {
    const operation = `redisCacheStore-${name}-${crypto.randomUUID()}`;
    const cache = new RedisCacheStore(operation, ttlMs, pruneIntervalMs);
    created.push(cache);
    const prefix = `cache:${operation}:`;

    return {
      cache,
      tracked: `${prefix}__keys`,
      expiry: `${prefix}__expiry`,
      entry: (key: string) => `${prefix}${Bun.hash(key).toString(36)}`,
      etagEntry: (key: string) => `${prefix}${Bun.hash(key).toString(36)}:etag`,
    };
  };

  // What a worker that predates the expiry index writes for an entry.
  const writeAsOlderVersion = async (
    target: ReturnType<typeof store>,
    key: string,
    ttlSeconds?: number,
  ) => {
    if (ttlSeconds) await client.set(target.entry(key), "{}", "EX", ttlSeconds);
    else await client.set(target.entry(key), "{}");
    await client.sadd(target.tracked, key);
  };

  it("expires an entry after the operation's TTL", async () => {
    const { cache } = store("ttl", 1000);

    await cache.set('{"k":1}', '{"data":1}');
    expect(await cache.get('{"k":1}')).toBe('{"data":1}');

    await Bun.sleep(1100);
    expect(await cache.get('{"k":1}')).toBeUndefined();
  });

  it("keeps an entry when the operation sets no TTL", async () => {
    const { cache } = store("no-ttl");

    await cache.set('{"k":1}', '{"data":1}');

    expect(await cache.get('{"k":1}')).toBe('{"data":1}');
    expect(await cache.keys()).toEqual(['{"k":1}']);
  });

  it("stops tracking an expired entry on the next write", async () => {
    const target = store("expiry-write", 1000);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);
    await target.cache.set('{"k":2}', "{}");

    // Read without `keys()`, which prunes too: writes alone keep the tracking bounded.
    expect(await client.smembers(target.tracked)).toEqual(['{"k":2}']);
  });

  it("keeps tracking an expired entry on the next write while the prune gate is closed", async () => {
    const target = store("gated", 1000, Number.MAX_SAFE_INTEGER);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);
    await target.cache.set('{"k":2}', "{}");

    // The gate is closed: the write keeps k1 tracked, pruning only in `keys()`.
    expect(await client.smembers(target.tracked)).toContain('{"k":1}');

    expect(await target.cache.keys()).toEqual(['{"k":2}']);
    expect(await client.smembers(target.tracked)).toEqual(['{"k":2}']);
  });

  it("prunes an expired entry on the next write while the prune gate is open", async () => {
    const target = store("ungated", 1000, 0);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);
    await target.cache.set('{"k":2}', "{}");

    expect(await client.smembers(target.tracked)).toEqual(['{"k":2}']);
  });

  it("reopens the prune gate on a write once the interval has elapsed", async () => {
    // Interval 1400 > TTL 1000: the write at ~1100 finds the gate closed and
    // keeps k1 tracked although it has expired, and the write at ~1600 finds it
    // open again and sweeps k1. This pins that lastPruneAt updates only when a
    // prune actually ran: updated on every write, the gate would never reopen.
    const target = store("reopen", 1000, 1400);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);
    await target.cache.set('{"k":2}', "{}");

    expect((await client.smembers(target.tracked)).sort()).toEqual(['{"k":1}', '{"k":2}']);

    await Bun.sleep(500);
    await target.cache.set('{"k":3}', "{}");

    expect((await client.smembers(target.tracked)).sort()).toEqual(['{"k":2}', '{"k":3}']);
  });

  it("stops tracking an expired entry when listing the keys", async () => {
    const target = store("expiry-keys", 1000);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);

    expect(await target.cache.keys()).toEqual([]);
    expect(await client.smembers(target.tracked)).toEqual([]);
  });

  it("keeps tracking an entry an older version cached again after it expired", async () => {
    const target = store("recached", 1000);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);
    await writeAsOlderVersion(target, '{"k":1}', 60);
    await target.cache.set('{"k":2}', "{}");

    expect((await target.cache.keys()).sort()).toEqual(['{"k":1}', '{"k":2}']);

    await target.cache.clear();
    expect(await target.cache.get('{"k":1}')).toBeUndefined();
  });

  it("keeps tracking an entry an older version cached again without a TTL", async () => {
    const target = store("recached-no-ttl", 1000);

    await target.cache.set('{"k":1}', "{}");
    await Bun.sleep(1100);
    await writeAsOlderVersion(target, '{"k":1}');
    await target.cache.set('{"k":2}', "{}");
    await target.cache.set('{"k":3}', "{}");

    expect((await target.cache.keys()).sort()).toEqual(['{"k":1}', '{"k":2}', '{"k":3}']);
  });

  it("deletes one entry and stops listing it", async () => {
    const { cache } = store("delete", 60_000);

    await cache.set('{"k":1}', "{}");
    await cache.set('{"k":2}', "{}");
    await cache.delete('{"k":1}');

    expect(await cache.get('{"k":1}')).toBeUndefined();
    expect(await cache.keys()).toEqual(['{"k":2}']);
  });

  it("clears more entries than one delete batch", async () => {
    const target = store("clear", 60_000);
    const keys = Array.from({ length: 2500 }, (_, index) => `{"k":${index}}`);

    await Promise.all(keys.map((key) => target.cache.set(key, "{}")));
    await target.cache.clear();

    expect(await target.cache.keys()).toEqual([]);
    expect(await target.cache.get(keys[0]!)).toBeUndefined();
    expect(await target.cache.get(keys.at(-1)!)).toBeUndefined();
    expect(await client.exists(target.tracked)).toBe(false);
    expect(await client.exists(target.expiry)).toBe(false);
  });

  it("clear() sweeps every entry and a stale legacy expiry member", async () => {
    const target = store("stream-clear", 60_000);
    const keys = Array.from({ length: 2100 }, (_, index) => `{"k":${index}}`);

    await Promise.all(keys.map((key) => target.cache.set(key, "{}")));

    // A member whose key left the tracking set (an older version's clear).
    const staleKey = "legacy-stale";
    await client.zadd(target.expiry, Date.now(), `${Bun.hash(staleKey).toString(36)}:${staleKey}`);
    await client.set(target.entry(staleKey), "{}");

    await target.cache.clear();

    expect(await client.smembers(target.tracked)).toEqual([]);
    expect(await client.zrange(target.expiry, 0, -1)).toEqual([]);
    for (const key of [keys[0]!, keys[1000]!, keys[2099]!, staleKey]) {
      expect(await client.exists(target.entry(key))).toBe(false);
    }
  });

  it("keys() lists a few hundred entries", async () => {
    const target = store("stream-keys", 60_000);
    const keys = Array.from({ length: 500 }, (_, index) => `{"k":${index}}`);

    await Promise.all(keys.map((key) => target.cache.set(key, "{}")));

    expect((await target.cache.keys()).sort()).toEqual(keys.sort());
  });

  it("lists, deletes and clears the entries an older version wrote", async () => {
    const target = store("legacy", 60_000);

    await writeAsOlderVersion(target, '{"k":1}', 60);
    await writeAsOlderVersion(target, '{"k":2}', 60);
    await target.cache.set('{"k":3}', "{}");

    expect((await target.cache.keys()).sort()).toEqual(['{"k":1}', '{"k":2}', '{"k":3}']);

    await target.cache.delete('{"k":1}');
    expect(await target.cache.get('{"k":1}')).toBeUndefined();
    expect((await target.cache.keys()).sort()).toEqual(['{"k":2}', '{"k":3}']);

    await target.cache.clear();
    expect(await target.cache.get('{"k":2}')).toBeUndefined();
    expect(await target.cache.keys()).toEqual([]);
    expect(await client.exists(target.tracked)).toBe(false);
  });

  it("lets an older version's clear remove the entries it writes", async () => {
    const target = store("upgrade", 60_000);

    await target.cache.set('{"k":1}', "{}");

    // What a worker that predates the expiry index does to clear the cache.
    for (const key of await client.smembers(target.tracked)) {
      await client.del(target.entry(key));
    }
    await client.del(target.tracked);

    expect(await target.cache.get('{"k":1}')).toBeUndefined();

    // What that clear leaves in the expiry index goes with the next one.
    await target.cache.clear();
    expect(await client.exists(target.expiry)).toBe(false);
  });

  it("stores and serves the precomputed etag alongside the entry", async () => {
    const target = store("etag");

    await target.cache.setWithEtag('{"k":1}', '{"data":1}', '"sha"');

    expect(await target.cache.getWithEtag('{"k":1}')).toEqual({
      value: '{"data":1}',
      etag: '"sha"',
    });
    expect(await target.cache.get('{"k":1}')).toBe('{"data":1}');
  });

  it("reports no etag for an entry written by an older version", async () => {
    const target = store("etag-old");

    await writeAsOlderVersion(target, '{"k":1}');

    expect(await target.cache.getWithEtag('{"k":1}')).toEqual({
      value: "{}",
      etag: undefined,
    });
  });

  it("expires the etag companion with the entry", async () => {
    const target = store("etag-ttl", 1000);

    await target.cache.setWithEtag('{"k":1}', "{}", '"sha"');
    await Bun.sleep(1100);

    expect(await target.cache.getWithEtag('{"k":1}')).toBeUndefined();
    expect(await client.get(target.etagEntry('{"k":1}'))).toBeNull();
  });

  it("removes the etag companion on delete and on clear", async () => {
    const target = store("etag-del");

    await target.cache.setWithEtag('{"k":1}', "{}", '"sha"');
    await target.cache.delete('{"k":1}');
    expect(await client.get(target.etagEntry('{"k":1}'))).toBeNull();

    await target.cache.setWithEtag('{"k":2}', "{}", '"sha"');
    await target.cache.clear();
    expect(await client.get(target.etagEntry('{"k":2}'))).toBeNull();
  });

  it("serves writes after a script flush (EVALSHA fallback)", async () => {
    const target = store("evalsha");

    await target.cache.set("k1", "v1");
    await client.send("SCRIPT", ["FLUSH"]);
    await target.cache.set("k2", "v2");

    expect(await target.cache.get("k2")).toBe("v2");
    expect(await client.smembers(target.tracked)).toContain("k2");
  });
});

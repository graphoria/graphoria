import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";

import { logger } from "../../logging";
import { RedisCacheStore } from "./redisCacheStore";
import { closeCacheRedisClient } from "./redisClient";

// Nothing listens here, so every command fails at once, as it does while Redis is down.
const UNREACHABLE_URL = "redis://127.0.0.1:6396";

afterEach(() => {
  setSystemTime();
  closeCacheRedisClient();
});

describe("RedisCacheStore while Redis is down", () => {
  it("logs failed reads and writes once per interval, not once per request", async () => {
    const error = spyOn(logger("redis-cache"), "error").mockImplementation((() => {}) as never);
    try {
      const store = new RedisCacheStore("list", UNREACHABLE_URL);
      const start = Date.now();
      setSystemTime(start);

      for (let request = 0; request < 5; request++) {
        expect(await store.getWithEtag("k")).toBeUndefined();
        await store.setWithEtag("k", "v", '"v"');
      }
      expect(error).toHaveBeenCalledTimes(1);

      setSystemTime(start + 10_000);
      expect(await store.get("k")).toBeUndefined();
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  it("logs every failed invalidation", async () => {
    const error = spyOn(logger("redis-cache"), "error").mockImplementation((() => {}) as never);
    try {
      const store = new RedisCacheStore("list", UNREACHABLE_URL);

      await store.delete("k");
      await store.clear();

      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("RedisCacheStore keys", () => {
  const hashed = Bun.hash("k").toString(36);

  // What the store sends its client, answered in place of Redis: a sha for
  // SCRIPT LOAD, nothing for the rest.
  const recording = (store: RedisCacheStore) => {
    const client = Reflect.get(store, "client");
    const sent: string[][] = [];
    const spies = [
      spyOn(client, "send").mockImplementation((async (command: string, args: string[]) => {
        sent.push([command, ...args]);
        return command === "SCRIPT" ? "sha" : 0;
      }) as never),
      spyOn(client, "mget").mockImplementation((async (...keys: string[]) => {
        sent.push(["MGET", ...keys]);
        return [null, null];
      }) as never),
    ];
    return { sent, restore: () => spies.forEach((spy) => spy.mockRestore()) };
  };

  it.each([
    ["no prefix", "", "cache:list:"],
    ["the store's prefix", "app1:", "app1:cache:list:"],
  ])("keys an entry, its etag and its indexes under %s", async (_, keyPrefix, entries) => {
    const store = new RedisCacheStore("list", UNREACHABLE_URL, keyPrefix);
    const { sent, restore } = recording(store);
    try {
      await store.setWithEtag("k", "v", '"v"');
      await store.getWithEtag("k");
    } finally {
      restore();
    }

    // The script's keys, then the prefix it reads entries under.
    expect(sent[1]!.slice(0, 8)).toEqual([
      "EVALSHA",
      "sha",
      "4",
      `${entries}__keys`,
      `${entries}__expiry`,
      `${entries}${hashed}`,
      `${entries}${hashed}:etag`,
      entries,
    ]);
    expect(sent[2]).toEqual(["MGET", `${entries}${hashed}`, `${entries}${hashed}:etag`]);
  });
});

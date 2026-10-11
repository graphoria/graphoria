import { describe, expect, it, spyOn } from "bun:test";

import type { CacheStore } from "./types";

import { logger } from "../../logging";
import { LruCacheStore } from "./lruCacheStore";
import { TieredCacheStore } from "./tieredCacheStore";

// A Map-backed store without the optional ETag methods.
const plainStore = (): CacheStore & { storage: Map<string, string> } => {
  const storage = new Map<string, string>();
  return {
    storage,
    get: async (key) => storage.get(key),
    set: async (key, value) => {
      storage.set(key, value);
    },
    delete: async (key) => {
      storage.delete(key);
    },
    clear: async () => {
      storage.clear();
    },
    keys: async () => [...storage.keys()],
  };
};

const failingStore = (): CacheStore => {
  const fail = async (): Promise<never> => {
    throw new Error("store down");
  };
  return {
    get: fail,
    set: fail,
    delete: fail,
    clear: fail,
    keys: fail,
    getWithEtag: fail,
    setWithEtag: fail,
  };
};

const memory = () => new LruCacheStore({ max: 10 });

// The names only label log lines, so the tests that read none take these.
const chain = (...stores: CacheStore[]) =>
  new TieredCacheStore(
    stores,
    stores.map((_, tier) => `store${tier}`),
  );

// A copy into the faster stores runs in the background; one macrotask lets it land.
const copied = () => Bun.sleep(0);

// A Map-backed store whose writes, deletes and clears wait until the test calls `release`.
// It has no setWithEtag, so that write falls back to `set`.
const gatedStore = () => {
  const gate = Promise.withResolvers<void>();
  const store = plainStore();
  return {
    ...store,
    release: () => gate.resolve(),
    set: async (key: string, value: string) => {
      await gate.promise;
      store.storage.set(key, value);
    },
    delete: async (key: string) => {
      await gate.promise;
      store.storage.delete(key);
    },
    clear: async () => {
      await gate.promise;
      store.storage.clear();
    },
  };
};

describe("TieredCacheStore", () => {
  it("misses when no store holds the key", async () => {
    const tiered = chain(memory(), plainStore());

    expect(await tiered.getWithEtag("k")).toBeUndefined();
    expect(await tiered.get("k")).toBeUndefined();
  });

  it("serves the first store's entry and etag", async () => {
    const first = memory();
    const second = plainStore();
    await first.setWithEtag("k", "first", '"f"');
    second.storage.set("k", "second");

    expect(await chain(first, second).getWithEtag("k")).toEqual({
      value: "first",
      etag: '"f"',
    });
  });

  it("serves a later store's entry and copies it, etag included, into the stores before it", async () => {
    const first = memory();
    const second = memory();
    const third = memory();
    await third.setWithEtag("k", "v", '"e"');

    expect(await chain(first, second, third).getWithEtag("k")).toEqual({
      value: "v",
      etag: '"e"',
    });
    await copied();
    expect(await first.getWithEtag("k")).toEqual({ value: "v", etag: '"e"' });
    expect(await second.getWithEtag("k")).toEqual({ value: "v", etag: '"e"' });
  });

  it("never copies a hit into the stores after it", async () => {
    const first = memory();
    const second = plainStore();
    await first.set("k", "v");

    await chain(first, second).get("k");
    await copied();

    expect(second.storage.has("k")).toBe(false);
  });

  it("reads a store without ETag support through get", async () => {
    const second = plainStore();
    second.storage.set("k", "v");

    expect(await chain(memory(), second).getWithEtag("k")).toEqual({
      value: "v",
    });
  });

  it("writes every store, with the etag where a store keeps one", async () => {
    const first = memory();
    const second = plainStore();

    await chain(first, second).setWithEtag("k", "v", '"e"');

    expect(await first.getWithEtag("k")).toEqual({ value: "v", etag: '"e"' });
    expect(second.storage.get("k")).toBe("v");
  });

  it("drops a stale etag when written without one", async () => {
    const first = memory();
    const tiered = chain(first, plainStore());

    await tiered.setWithEtag("k", "old", '"old"');
    await tiered.set("k", "new");

    expect(await first.getWithEtag("k")).toEqual({ value: "new", etag: undefined });
  });

  it("deletes from and clears every store", async () => {
    const first = plainStore();
    const second = plainStore();
    const tiered = chain(first, second);
    await tiered.set("a", "1");
    await tiered.set("b", "2");

    await tiered.delete("a");
    expect([...first.storage.keys()]).toEqual(["b"]);
    expect([...second.storage.keys()]).toEqual(["b"]);

    await tiered.clear();
    expect(first.storage.size + second.storage.size).toBe(0);
  });

  it("lists every store's keys once", async () => {
    const first = plainStore();
    const second = plainStore();
    first.storage.set("a", "1");
    second.storage.set("a", "1");
    second.storage.set("b", "2");

    expect((await chain(first, second).keys()).sort()).toEqual(["a", "b"]);
  });

  it("skips a failing store on read", async () => {
    const second = plainStore();
    second.storage.set("k", "v");

    expect(await chain(failingStore(), second).get("k")).toBe("v");
  });

  it("never throws when a store fails to write, delete, list or clear", async () => {
    const healthy = plainStore();
    const tiered = chain(failingStore(), healthy);

    await tiered.setWithEtag("k", "v", '"e"');
    expect(healthy.storage.get("k")).toBe("v");
    await tiered.delete("k");
    expect(healthy.storage.has("k")).toBe(false);
    healthy.storage.set("x", "1");
    expect(await tiered.keys()).toEqual(["x"]);
    await tiered.clear();
    expect(healthy.storage.size).toBe(0);
  });

  it.each([
    ["get", "memory", (tiered: TieredCacheStore) => tiered.get("k")],
    ["set", "redis", (tiered: TieredCacheStore) => tiered.set("k", "v")],
  ])("names the store that fails a %s in its log", async (operation, failing, run) => {
    const error = spyOn(logger("tiered-cache"), "error").mockImplementation((() => {}) as never);
    const stores = { memory: plainStore(), redis: plainStore(), [failing]: failingStore() };

    try {
      await run(new TieredCacheStore([stores.memory, stores.redis], ["memory", "redis"]));

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ store: failing, operation }),
        "cache tier failed",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("serves the hit when the copy into a faster store fails", async () => {
    const second = plainStore();
    second.storage.set("k", "v");
    const full: CacheStore = {
      ...plainStore(),
      set: async () => {
        throw new Error("full");
      },
    };

    expect(await chain(full, second).get("k")).toBe("v");
    await copied();
  });

  it.each([
    ["set", (tiered: TieredCacheStore) => tiered.set("k", "v")],
    ["setWithEtag", (tiered: TieredCacheStore) => tiered.setWithEtag("k", "v", '"e"')],
    ["delete", (tiered: TieredCacheStore) => tiered.delete("k")],
    ["clear", (tiered: TieredCacheStore) => tiered.clear()],
  ])("resolves %s only once every store has taken it", async (_method, run) => {
    const slow = gatedStore();
    let resolved = false;
    const pending = run(chain(memory(), slow)).then(() => {
      resolved = true;
    });

    await copied();
    expect(resolved).toBe(false);

    slow.release();
    await pending;
    expect(resolved).toBe(true);
  });

  it("serves a hit before its copy into a faster store lands", async () => {
    const fast = gatedStore();
    const slow = plainStore();
    slow.storage.set("k", "v");

    expect(await chain(fast, slow).get("k")).toBe("v");
    expect(fast.storage.has("k")).toBe(false);

    fast.release();
    await copied();
    expect(fast.storage.get("k")).toBe("v");
  });
});

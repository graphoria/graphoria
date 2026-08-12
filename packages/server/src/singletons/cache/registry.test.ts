import { describe, expect, it } from "bun:test";

import type { CacheStore } from "./types";

import { getCache, InvalidationHelper, registerCache } from "./registry";

const makeFakeCache = (): CacheStore & { storage: Map<string, unknown> } => {
  const storage = new Map<string, unknown>();
  return {
    storage,
    get: async (k) => storage.get(k),
    set: async (k, v) => {
      storage.set(k, v);
    },
    delete: async (k) => {
      storage.delete(k);
    },
    clear: async () => {
      storage.clear();
    },
    keys: async () => [...storage.keys()],
  };
};

// Cache names are namespaced per test to avoid the module-level registry
// being polluted across tests / test files.
const ns = (label: string) => `registry-test:${label}:${Math.random()}`;

describe("registerCache / getCache", () => {
  it("getCache returns undefined for unknown names", () => {
    expect(getCache(ns("missing"))).toBeUndefined();
  });

  it("registerCache stores and getCache retrieves", () => {
    const name = ns("basic");
    const cache = makeFakeCache();
    registerCache(name, cache);
    expect(getCache(name)).toBe(cache);
  });

  it("registerCache overwrites a previously-registered cache for the same name", () => {
    const name = ns("overwrite");
    const a = makeFakeCache();
    const b = makeFakeCache();
    registerCache(name, a);
    registerCache(name, b);
    expect(getCache(name)).toBe(b);
  });
});

describe("InvalidationHelper.invalidate", () => {
  it("returns false when the named cache is not registered", async () => {
    const ok = await InvalidationHelper.invalidate(ns("nope"));
    expect(ok).toBe(false);
  });

  it("clears the entire cache when no pattern is supplied", async () => {
    const name = ns("full-clear");
    const cache = makeFakeCache();
    await cache.set("k1", 1);
    await cache.set("k2", 2);
    registerCache(name, cache);

    const ok = await InvalidationHelper.invalidate(name);

    expect(ok).toBe(true);
    expect(await cache.keys()).toEqual([]);
  });

  it("clears the entire cache when an empty pattern object is supplied", async () => {
    const name = ns("empty-pattern");
    const cache = makeFakeCache();
    await cache.set("k1", 1);
    registerCache(name, cache);

    await InvalidationHelper.invalidate(name, {});

    expect(await cache.keys()).toEqual([]);
  });

  it("invalidates only entries whose JSON-encoded key.variables match the pattern", async () => {
    const name = ns("pattern");
    const cache = makeFakeCache();
    await cache.set(JSON.stringify({ pathname: "/x", variables: { id: 1 } }), "v1");
    await cache.set(JSON.stringify({ pathname: "/x", variables: { id: 2 } }), "v2");
    await cache.set(JSON.stringify({ pathname: "/x", variables: { id: 1, role: "admin" } }), "v3");
    registerCache(name, cache);

    await InvalidationHelper.invalidate(name, { id: 1 });

    const remaining = await cache.keys();
    // Only the id:2 entry survives.
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]!).variables.id).toBe(2);
  });

  it("ignores keys that do not parse as JSON", async () => {
    const name = ns("non-json");
    const cache = makeFakeCache();
    await cache.set("not-json", "v1");
    await cache.set(JSON.stringify({ variables: { id: 1 } }), "v2");
    registerCache(name, cache);

    const ok = await InvalidationHelper.invalidate(name, { id: 1 });

    expect(ok).toBe(true);
    // Non-JSON key untouched, JSON match deleted.
    expect(await cache.get("not-json")).toBe("v1");
    expect(await cache.keys()).toEqual(["not-json"]);
  });
});

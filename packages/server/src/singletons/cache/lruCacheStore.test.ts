import { describe, expect, it } from "bun:test";

import { LruCacheStore } from "./lruCacheStore";

describe("LruCacheStore", () => {
  describe("get / set / delete", () => {
    it("returns undefined for unknown keys", async () => {
      const store = new LruCacheStore({ max: 10 });
      expect(await store.get("nope")).toBeUndefined();
    });

    it("returns the value previously set", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("k1", { v: 1 });
      expect(await store.get("k1")).toEqual({ v: 1 });
    });

    it("overwrites on repeat set", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("k1", "first");
      await store.set("k1", "second");
      expect(await store.get("k1")).toBe("second");
    });

    it("removes the value on delete", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("k1", "v");
      await store.delete("k1");
      expect(await store.get("k1")).toBeUndefined();
    });

    it("delete on missing key is a no-op", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.delete("nope");
      expect(await store.get("nope")).toBeUndefined();
    });
  });

  describe("clear / keys", () => {
    it("clear empties the cache", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("a", 1);
      await store.set("b", 2);
      await store.clear();
      expect(await store.keys()).toEqual([]);
    });

    it("keys lists all current keys", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("a", 1);
      await store.set("b", 2);
      const ks = (await store.keys()).sort();
      expect(ks).toEqual(["a", "b"]);
    });
  });

  describe("eviction at capacity", () => {
    it("evicts the least-recently-used entry when max exceeded", async () => {
      const store = new LruCacheStore({ max: 2 });
      await store.set("a", 1);
      await store.set("b", 2);
      await store.set("c", 3); // evicts "a"

      expect(await store.get("a")).toBeUndefined();
      expect(await store.get("b")).toBe(2);
      expect(await store.get("c")).toBe(3);
    });

    it("touches LRU order on get so the touched entry survives", async () => {
      const store = new LruCacheStore({ max: 2 });
      await store.set("a", 1);
      await store.set("b", 2);
      // get("a") makes "a" most-recently-used; "b" is now LRU
      await store.get("a");
      await store.set("c", 3); // evicts "b"

      expect(await store.get("a")).toBe(1);
      expect(await store.get("b")).toBeUndefined();
      expect(await store.get("c")).toBe(3);
    });
  });

  describe("ttl expiry", () => {
    it("returns undefined after the entry's ttl elapses", async () => {
      const store = new LruCacheStore({ max: 10, ttl: 30 });
      await store.set("k1", "v");
      expect(await store.get("k1")).toBe("v");

      await new Promise((r) => setTimeout(r, 60));

      expect(await store.get("k1")).toBeUndefined();
    });
  });

  describe("value types", () => {
    it("preserves arbitrary value types (objects, arrays, primitives)", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("obj", { nested: [1, 2, 3] });
      await store.set("arr", [1, "two", null]);
      await store.set("num", 42);
      await store.set("nul", null);

      expect(await store.get("obj")).toEqual({ nested: [1, 2, 3] });
      expect(await store.get("arr")).toEqual([1, "two", null]);
      expect(await store.get("num")).toBe(42);
      expect(await store.get("nul")).toBeNull();
    });
  });
});

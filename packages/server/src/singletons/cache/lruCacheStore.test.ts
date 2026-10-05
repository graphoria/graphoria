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
      await store.set("k1", '{"v":1}');
      expect(await store.get("k1")).toBe('{"v":1}');
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
      await store.set("a", "1");
      await store.set("b", "2");
      await store.clear();
      expect(await store.keys()).toEqual([]);
    });

    it("keys lists all current keys", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("a", "1");
      await store.set("b", "2");
      const ks = (await store.keys()).sort();
      expect(ks).toEqual(["a", "b"]);
    });
  });

  describe("eviction at capacity", () => {
    it("evicts the least-recently-used entry when max exceeded", async () => {
      const store = new LruCacheStore({ max: 2 });
      await store.set("a", "1");
      await store.set("b", "2");
      await store.set("c", "3"); // evicts "a"

      expect(await store.get("a")).toBeUndefined();
      expect(await store.get("b")).toBe("2");
      expect(await store.get("c")).toBe("3");
    });

    it("touches LRU order on get so the touched entry survives", async () => {
      const store = new LruCacheStore({ max: 2 });
      await store.set("a", "1");
      await store.set("b", "2");
      // get("a") makes "a" most-recently-used; "b" is now LRU
      await store.get("a");
      await store.set("c", "3"); // evicts "b"

      expect(await store.get("a")).toBe("1");
      expect(await store.get("b")).toBeUndefined();
      expect(await store.get("c")).toBe("3");
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

  describe("etags", () => {
    it("stores and returns the etag written with the value", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.setWithEtag("k1", '{"v":1}', '"abc"');
      expect(await store.getWithEtag("k1")).toEqual({ value: '{"v":1}', etag: '"abc"' });
    });

    it("returns undefined for an unknown key", async () => {
      const store = new LruCacheStore({ max: 10 });
      expect(await store.getWithEtag("nope")).toBeUndefined();
    });

    it("reports no etag for a value stored without one", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("k1", "v");
      expect(await store.getWithEtag("k1")).toEqual({ value: "v", etag: undefined });
    });

    it("drops a stale etag when the value is overwritten without one", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.setWithEtag("k1", "v1", '"a"');
      await store.set("k1", "v2");
      expect(await store.getWithEtag("k1")).toEqual({ value: "v2", etag: undefined });
    });

    it("removes the etag on delete and on clear", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.setWithEtag("a", "1", '"a1"');
      await store.delete("a");
      expect(await store.getWithEtag("a")).toBeUndefined();

      await store.setWithEtag("b", "2", '"b2"');
      await store.clear();
      expect(await store.getWithEtag("b")).toBeUndefined();
    });
  });

  describe("value types", () => {
    it("returns the stored JSON text unchanged", async () => {
      const store = new LruCacheStore({ max: 10 });
      await store.set("obj", '{"nested":[1,2,3]}');
      await store.set("nul", "null");

      expect(await store.get("obj")).toBe('{"nested":[1,2,3]}');
      expect(await store.get("nul")).toBe("null");
    });
  });
});

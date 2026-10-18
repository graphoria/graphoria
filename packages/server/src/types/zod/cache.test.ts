import { describe, expect, it } from "bun:test";

import { ConfigurationZod } from "./configuration";

const base = { name: "test", version: "1.0.0" };
const redis = (url = "redis://cache:6379") => ({ type: "redis" as const, url });
const cached = (cache: Record<string, unknown>) => ({ query: "{ ping }", cache });

const problems = (input: Record<string, unknown>) => {
  const result = ConfigurationZod.safeParse({ ...base, ...input });
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("caches", () => {
  it("reads from the in-process store when nothing is declared", () => {
    expect(ConfigurationZod.parse(base).caches).toEqual({ default: ["memory"], stores: {} });
  });

  it("accepts a redis store behind memory", () => {
    const caches = { default: ["memory", "shared"], stores: { shared: redis() } };

    expect(ConfigurationZod.parse({ ...base, caches }).caches).toEqual(caches);
  });

  it("keeps a redis store's prefix as written", () => {
    const caches = {
      default: ["memory", "shared"],
      stores: { shared: { ...redis(), prefix: "app1:" } },
    };

    expect(ConfigurationZod.parse({ ...base, caches }).caches).toEqual(caches);
  });

  it.each(["", ":", ":app1", "app 1", "app*", "{app1}"])("rejects the prefix %p", (prefix) => {
    expect(problems({ caches: { stores: { s: { ...redis(), prefix } } } })).toEqual([
      "caches.stores.s.prefix: letters, digits, _, - and : only, not starting with :",
    ]);
  });

  it("rejects a store named memory", () => {
    expect(problems({ caches: { stores: { memory: redis() } } })).toEqual([
      'caches.stores.memory: "memory" is the built-in in-process store and cannot be declared',
    ]);
  });

  it("rejects an unknown store in the default chain", () => {
    expect(problems({ caches: { default: ["memory", "nope"] } })).toEqual([
      'caches.default.1: unknown cache store "nope": declare it in caches.stores, or use "memory"',
    ]);
  });

  it("rejects an undeclared store named after an Object.prototype member", () => {
    expect(problems({ caches: { default: ["toString"] } })).toEqual([
      'caches.default.0: unknown cache store "toString": declare it in caches.stores, or use "memory"',
    ]);
    expect(problems({ caches: { default: ["__proto__"] } })).toEqual([
      'caches.default.0: unknown cache store "__proto__": declare it in caches.stores, or use "memory"',
    ]);
  });

  it("rejects a store listed twice", () => {
    expect(problems({ caches: { default: ["memory", "memory"] } })).toEqual([
      'caches.default.1: cache store "memory" is listed twice',
    ]);
  });

  it("rejects two stores on one Redis URL and prefix in one chain", () => {
    expect(
      problems({ caches: { default: ["a", "b"], stores: { a: redis(), b: redis() } } }),
    ).toEqual([
      'caches.default.1: cache stores "a" and "b" use the same Redis URL and prefix, so their entries would share keys',
    ]);
  });

  it("accepts two stores on one Redis URL in one chain when their prefixes differ", () => {
    const stores = { a: { ...redis(), prefix: "one" }, b: { ...redis(), prefix: "two" } };

    expect(problems({ caches: { default: ["a", "b"], stores } })).toEqual([]);
  });

  it("rejects two prefixes that differ only by a trailing colon", () => {
    const stores = { a: { ...redis(), prefix: "one" }, b: { ...redis(), prefix: "one:" } };

    expect(problems({ caches: { default: ["a", "b"], stores } })).toEqual([
      'caches.default.1: cache stores "a" and "b" use the same Redis URL and prefix, so their entries would share keys',
    ]);
  });

  it("accepts two stores on one Redis URL when no chain lists both", () => {
    expect(
      problems({ caches: { default: ["memory", "a"], stores: { a: redis(), b: redis() } } }),
    ).toEqual([]);
  });

  it("rejects an unknown store in an operation's stores", () => {
    expect(problems({ operations: { list: cached({ ttl: 1_000, stores: ["nope"] }) } })).toEqual([
      'operations.list.cache.stores.0: unknown cache store "nope": declare it in caches.stores, or use "memory"',
    ]);
  });

  it("rejects memory fields when the operation's stores leave memory out", () => {
    expect(
      problems({
        caches: { stores: { shared: redis() } },
        operations: { list: cached({ ttl: 1_000, max: 10, stores: ["shared"] }) },
      }),
    ).toEqual([
      'operations.list.cache: the "memory" store is not in this operation\'s chain, so max would be ignored',
    ]);
  });

  it("rejects memory fields when the default chain leaves memory out", () => {
    expect(
      problems({
        caches: { default: ["shared"], stores: { shared: redis() } },
        operations: { list: cached({ maxSize: 100, allowStale: true }) },
      }),
    ).toEqual([
      'operations.list.cache: the "memory" store is not in this operation\'s chain, so maxSize, allowStale would be ignored',
    ]);
  });

  it("requires max, maxSize or ttl when the chain holds memory", () => {
    expect(problems({ operations: { list: cached({ allowStale: true }) } })).toEqual([
      'operations.list.cache: the "memory" store needs max, maxSize or ttl',
    ]);
  });

  it("accepts ttl alone on a redis-only chain", () => {
    expect(
      problems({
        caches: { stores: { shared: redis() } },
        operations: { list: cached({ ttl: 1_000, stores: ["shared"] }) },
      }),
    ).toEqual([]);
  });

  it.each([{ max: 10 }, { maxSize: 100 }, { ttl: 1_000 }])(
    "accepts %o for an operation on the default memory chain",
    (cache) => {
      expect(problems({ operations: { list: cached(cache) } })).toEqual([]);
    },
  );

  it("rejects an unknown key and an unknown type in a store", () => {
    expect(problems({ caches: { stores: { s: { ...redis(), db: 1 } } } })).toEqual([
      'caches.stores.s: Unrecognized key: "db"',
    ]);
    expect(problems({ caches: { stores: { s: { type: "memcached", url: "x" } } } })).toEqual([
      "caches.stores.s.type: Invalid discriminator value. Expected 'redis'",
    ]);
  });
});

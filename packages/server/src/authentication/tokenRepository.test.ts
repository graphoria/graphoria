import { beforeEach, describe, expect, it } from "bun:test";

import type { TokenRepositoryClient } from "./tokenRepository";

import { createTokenRepositoryWithClient } from "./tokenRepository";

const createFakeClient = (): TokenRepositoryClient & {
  store: Map<string, Record<string, string>>;
  ttls: Map<string, number>;
} => {
  const store = new Map<string, Record<string, string>>();
  const ttls = new Map<string, number>();

  return {
    store,
    ttls,
    hset: async (key, fields) => {
      const existing = store.get(key) ?? {};
      store.set(key, { ...existing, ...fields });
    },
    hmget: async (key, fields) => {
      const hash = store.get(key);
      return fields.map((f) => hash?.[f] ?? null);
    },
    expire: async (key, seconds) => {
      ttls.set(key, seconds);
    },
  };
};

describe("tokenRepository", () => {
  let client: ReturnType<typeof createFakeClient>;
  let repo: ReturnType<typeof createTokenRepositoryWithClient>;

  beforeEach(() => {
    client = createFakeClient();
    repo = createTokenRepositoryWithClient(client);
  });

  it("fresh JTI is neither used nor revoked", async () => {
    expect(await repo.isTokenUsed("jti-fresh")).toBe(false);
    expect(await repo.isRevoked("jti-fresh")).toBe(false);
  });

  it("saveJti marks token as used and sets TTL", async () => {
    await repo.saveJti("jti-1", "5m");
    expect(await repo.isTokenUsed("jti-1")).toBe(true);
    expect(await repo.isRevoked("jti-1")).toBe(false);
    expect(client.ttls.get("jti-1")).toBe(300);
  });

  it("revoke flags token as revoked while keeping isUsed", async () => {
    await repo.saveJti("jti-2", "5m");
    await repo.revoke("jti-2");
    expect(await repo.isRevoked("jti-2")).toBe(true);
    expect(await repo.isTokenUsed("jti-2")).toBe(true);
  });

  it("revoke is a no-op for unsaved JTIs (no orphan keys)", async () => {
    await repo.revoke("jti-orphan");
    expect(await repo.isRevoked("jti-orphan")).toBe(false);
    expect(client.store.has("jti-orphan")).toBe(false);
  });

  it("revoke does not extend TTL on existing token", async () => {
    await repo.saveJti("jti-3", "5m");
    const ttlBefore = client.ttls.get("jti-3");
    await repo.revoke("jti-3");
    expect(client.ttls.get("jti-3")).toBe(ttlBefore);
  });

  it("isRevoked fails closed when client throws", async () => {
    const throwingClient: TokenRepositoryClient = {
      hset: async () => {
        throw new Error("redis down");
      },
      hmget: async () => {
        throw new Error("redis down");
      },
      expire: async () => {
        throw new Error("redis down");
      },
    };
    const failRepo = createTokenRepositoryWithClient(throwingClient);
    expect(await failRepo.isRevoked("any")).toBe(true);
    expect(await failRepo.isTokenUsed("any")).toBe(true);
  });
});

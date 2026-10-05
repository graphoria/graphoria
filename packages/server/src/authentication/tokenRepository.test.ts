import { beforeEach, describe, expect, it } from "bun:test";

import type { TokenRepositoryClient } from "./tokenRepository";

import {
  createShardedTokenRepositoryClient,
  createTokenRepositoryWithClient,
} from "./tokenRepository";

type FakeClient = TokenRepositoryClient & {
  store: Map<string, Record<string, string>>;
  ttls: Map<string, number>;
  closes: number;
};

const createFakeClient = (): FakeClient => {
  const store = new Map<string, Record<string, string>>();
  const ttls = new Map<string, number>();

  const client: FakeClient = {
    store,
    ttls,
    closes: 0,
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
    close: () => {
      client.closes++;
    },
  };
  return client;
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
    await repo.revoke("jti-2", "7d");
    expect(await repo.isRevoked("jti-2")).toBe(true);
    expect(await repo.isTokenUsed("jti-2")).toBe(true);
  });

  it("revoke records a JTI that was never saved, and gives it a TTL", async () => {
    // Access tokens and unused refresh tokens never pass through saveJti, so a
    // revoke that only wrote to already-saved keys could not log anyone out.
    await repo.revoke("jti-orphan", "7d");
    expect(await repo.isRevoked("jti-orphan")).toBe(true);
    expect(client.ttls.get("jti-orphan")).toBe(604800);
  });

  it("revoke does not extend TTL on existing token", async () => {
    await repo.saveJti("jti-3", "5m");
    const ttlBefore = client.ttls.get("jti-3");
    await repo.revoke("jti-3", "7d");
    expect(client.ttls.get("jti-3")).toBe(ttlBefore);
  });

  it("revoke is idempotent", async () => {
    await repo.revoke("jti-4", "7d");
    client.ttls.delete("jti-4");
    await repo.revoke("jti-4", "7d");
    expect(await repo.isRevoked("jti-4")).toBe(true);
    expect(client.ttls.has("jti-4")).toBe(false);
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
      close: () => {},
    };
    const failRepo = createTokenRepositoryWithClient(throwingClient);
    expect(await failRepo.isRevoked("any")).toBe(true);
    expect(await failRepo.isTokenUsed("any")).toBe(true);
  });

  it("checkRefresh reads both flags in one call", async () => {
    await repo.saveJti("jti-both", "5m");
    expect(await repo.checkRefresh("jti-both")).toEqual({ isUsed: true, isRevoked: false });

    await repo.revoke("jti-both", "7d");
    expect(await repo.checkRefresh("jti-both")).toEqual({ isUsed: true, isRevoked: true });
  });

  it("checkRefresh fails closed when client throws", async () => {
    const throwingClient: TokenRepositoryClient = {
      hset: async () => {},
      hmget: async () => {
        throw new Error("redis down");
      },
      expire: async () => {},
      close: () => {},
    };
    const failRepo = createTokenRepositoryWithClient(throwingClient);
    expect(await failRepo.checkRefresh("any")).toEqual({ isUsed: true, isRevoked: true });
  });

  it("close() closes its Redis client", () => {
    repo.close();

    expect(client.closes).toBe(1);
  });

  describe("createShardedTokenRepositoryClient", () => {
    it("routes every command for one key to the same client", async () => {
      const a = createFakeClient();
      const b = createFakeClient();
      const sharded = createShardedTokenRepositoryClient([a, b]);

      await sharded.hset("jti-x", { isUsed: "true" });
      await sharded.hmget("jti-x", ["isUsed"]);
      await sharded.expire("jti-x", 60);

      const saw = [a, b].filter((candidate) => candidate.store.has("jti-x"));
      expect(saw).toHaveLength(1);
    });

    it("spreads keys across clients", async () => {
      const clients = Array.from({ length: 4 }, () => createFakeClient());
      const sharded = createShardedTokenRepositoryClient(clients);

      for (let index = 0; index < 50; index += 1) {
        await sharded.hset(`jti-${index}`, { isUsed: "true" });
      }

      const used = clients.filter((candidate) => candidate.store.size > 0);
      expect(used.length).toBeGreaterThan(1);
    });

    it("closes every client", () => {
      const clients = [createFakeClient(), createFakeClient()];

      createShardedTokenRepositoryClient(clients).close();

      expect(clients.map((candidate) => candidate.closes)).toEqual([1, 1]);
    });
  });
});

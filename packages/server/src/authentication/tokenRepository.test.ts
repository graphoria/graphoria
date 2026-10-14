import { beforeEach, describe, expect, it } from "bun:test";

import type { TokenRepositoryClient } from "./tokenRepository";

import {
  createConfiguredTokenRepository,
  createMemoryTokenRepository,
  createMemoryTokenRepositoryClient,
  createShardedTokenRepositoryClient,
  createTokenRepositoryWithClient,
  retryAfterReconnect,
} from "./tokenRepository";

type FakeClient = TokenRepositoryClient & {
  store: Map<string, Record<string, string>>;
  ttls: Map<string, number>;
  closes: number;
  pings: number;
};

const createFakeClient = (answer = "PONG"): FakeClient => {
  const store = new Map<string, Record<string, string>>();
  const ttls = new Map<string, number>();

  const client: FakeClient = {
    store,
    ttls,
    closes: 0,
    pings: 0,
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
    ping: async () => {
      client.pings++;
      return answer;
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
      ping: async () => {
        throw new Error("redis down");
      },
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
      ping: async () => "PONG",
    };
    const failRepo = createTokenRepositoryWithClient(throwingClient);
    expect(await failRepo.checkRefresh("any")).toEqual({ isUsed: true, isRevoked: true });
  });

  it("close() closes its Redis client", () => {
    repo.close();

    expect(client.closes).toBe(1);
  });

  it("answers a ping only while its client answers PONG", async () => {
    expect(await repo.ping()).toBe(true);
    expect(await createTokenRepositoryWithClient(createFakeClient("LOADING")).ping()).toBe(false);
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

    it("pings every client, and answers PONG only when each one does", async () => {
      const clients = [createFakeClient(), createFakeClient("LOADING"), createFakeClient()];

      expect(await createShardedTokenRepositoryClient(clients).ping()).toBe("LOADING");
      expect(clients.map((candidate) => candidate.pings)).toEqual([1, 1, 1]);
      expect(await createShardedTokenRepositoryClient([createFakeClient()]).ping()).toBe("PONG");
    });

    it("closes every client", () => {
      const clients = [createFakeClient(), createFakeClient()];

      createShardedTokenRepositoryClient(clients).close();

      expect(clients.map((candidate) => candidate.closes)).toEqual([1, 1]);
    });
  });
});

describe("retryAfterReconnect", () => {
  // Like Bun's client with its offline queue off, a command fails at once while disconnected.
  const createDroppedClient = (failure?: Error) => {
    const state = { connected: false, commands: 0 };
    const command = async <T>(answer: T): Promise<T> => {
      state.commands++;
      if (!state.connected) throw new Error("Connection closed");
      if (failure) throw failure;
      return answer;
    };
    const client: TokenRepositoryClient & { readonly connected: boolean } = {
      get connected() {
        return state.connected;
      },
      hset: () => command(1),
      hmget: (_key, fields) => command(fields.map(() => null)),
      expire: () => command(1),
      ping: () => command("PONG"),
      close: () => {},
    };
    return { client, state };
  };

  it("reads a JTI through a reconnect rather than failing closed", async () => {
    const { client, state } = createDroppedClient();
    setTimeout(() => (state.connected = true), 30);
    const repository = createTokenRepositoryWithClient(retryAfterReconnect(client, 1_000));

    expect(await repository.isRevoked("jti")).toBe(false);
    expect(state.commands).toBe(2);
  });

  it("fails once the connection stays down past the wait", async () => {
    const { client, state } = createDroppedClient();
    const started = performance.now();

    await expect(retryAfterReconnect(client, 50).hmget("jti", ["isRevoked"])).rejects.toThrow(
      "Connection closed",
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(49);
    expect(state.commands).toBe(2);
  });

  it("fails at once on an error from a live connection", async () => {
    const { client, state } = createDroppedClient(new Error("WRONGTYPE"));
    state.connected = true;

    await expect(
      retryAfterReconnect(client, 1_000).hset("jti", { isUsed: "true" }),
    ).rejects.toThrow("WRONGTYPE");
    expect(state.commands).toBe(1);
  });

  it("answers a ping without waiting", async () => {
    const { client, state } = createDroppedClient();
    const started = performance.now();

    await expect(retryAfterReconnect(client, 1_000).ping()).rejects.toThrow("Connection closed");
    expect(performance.now() - started).toBeLessThan(100);
    expect(state.commands).toBe(1);
  });
});

describe("memory token repository", () => {
  it("always answers a ping: nothing stands between it and the process", async () => {
    expect(await createMemoryTokenRepository().ping()).toBe(true);
  });

  const clocked = () => {
    const clock = { now: 0 };
    const records = new Map();
    const repository = createTokenRepositoryWithClient(
      createMemoryTokenRepositoryClient(() => clock.now, records),
    );
    return { clock, records, repository };
  };

  it("marks a saved JTI used, and a revoked one revoked", async () => {
    const repository = createMemoryTokenRepository();

    await repository.saveJti("a", "1h");
    await repository.revoke("b", "1h");

    expect(await repository.isTokenUsed("a")).toBe(true);
    expect(await repository.isRevoked("a")).toBe(false);
    expect(await repository.checkRefresh("b")).toEqual({ isUsed: false, isRevoked: true });
  });

  it("forgets a JTI once its TTL passes", async () => {
    const { clock, repository } = clocked();
    await repository.saveJti("c", "1s");

    clock.now = 999;
    expect(await repository.isTokenUsed("c")).toBe(true);
    clock.now = 1_000;
    expect(await repository.isTokenUsed("c")).toBe(false);
  });

  it("keeps a used JTI's TTL when it is revoked, as the Redis store does", async () => {
    const { clock, repository } = clocked();
    await repository.saveJti("d", "1s");
    clock.now = 500;
    await repository.revoke("d", "1h");

    clock.now = 1_000;
    expect(await repository.isRevoked("d")).toBe(false);
  });

  it("keeps a used JTI used when it is revoked", async () => {
    const { repository } = clocked();
    await repository.saveJti("f", "1h");
    await repository.revoke("f", "1h");

    expect(await repository.checkRefresh("f")).toEqual({ isUsed: true, isRevoked: true });
  });

  it("keeps a revoked JTI revoked when it is saved as used", async () => {
    const { repository } = clocked();
    await repository.revoke("g", "1h");
    await repository.saveJti("g", "1h");

    expect(await repository.checkRefresh("g")).toEqual({ isUsed: true, isRevoked: true });
  });

  it("starts a clean record for a JTI rewritten after it expired", async () => {
    const { clock, repository } = clocked();
    await repository.saveJti("h", "1s");

    clock.now = 1_000;
    await repository.revoke("h", "1h");

    expect(await repository.checkRefresh("h")).toEqual({ isUsed: false, isRevoked: true });
  });

  it("drops expired records on a later write", async () => {
    const { clock, records, repository } = clocked();
    await repository.saveJti("old", "1s");

    clock.now = 61_000;
    await repository.saveJti("new", "1h");

    expect([...records.keys()]).toEqual(["new"]);
  });
});

describe("createConfiguredTokenRepository", () => {
  // Nothing listens here, and no test sends the Redis store a command.
  const caches = {
    default: ["memory"],
    stores: { tokens: { type: "redis" as const, url: "redis://127.0.0.1:6393" } },
  };

  it("requires AUTH_STORE when auth is on", () => {
    expect(() => createConfiguredTokenRepository(true, undefined, caches)).toThrow(
      "AUTH_STORE is required when auth is enabled",
    );
  });

  it("keeps tokens in this process when auth is off and AUTH_STORE is unset", async () => {
    const repository = createConfiguredTokenRepository(false, undefined, caches);

    await repository.saveJti("e", "1h");
    expect(await repository.isTokenUsed("e")).toBe(true);
  });

  it("keeps tokens in this process for AUTH_STORE=memory", async () => {
    const repository = createConfiguredTokenRepository(true, "memory", caches);

    await repository.revoke("f", "1h");
    expect(await repository.isRevoked("f")).toBe(true);
  });

  it("rejects an AUTH_STORE that names no store", () => {
    expect(() => createConfiguredTokenRepository(true, "nope", caches)).toThrow(
      "AUTH_STORE=nope names no store",
    );
  });

  it("reads AUTH_STORE with auth off too, so it rejects one that names no store", () => {
    expect(() => createConfiguredTokenRepository(false, "nope", caches)).toThrow(
      "AUTH_STORE=nope names no store",
    );
  });

  it("keeps tokens in this process when AUTH_STORE is optional and unset", async () => {
    const repository = createConfiguredTokenRepository(true, undefined, caches, false);

    await repository.revoke("h", "1h");
    expect(await repository.isRevoked("h")).toBe(true);
  });

  it("still rejects an optional AUTH_STORE that names no store", () => {
    expect(() => createConfiguredTokenRepository(true, "nope", caches, false)).toThrow(
      "AUTH_STORE=nope names no store",
    );
  });

  it("builds a Redis repository for a declared store, and closes it", () => {
    expect(() => createConfiguredTokenRepository(true, "tokens", caches).close()).not.toThrow();
  });
});

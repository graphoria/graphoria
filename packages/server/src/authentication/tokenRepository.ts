import type { Configuration } from "../types/configuration";

import { parseDurationToMs } from "./duration";
import { MEMORY_STORE } from "../config/types/cache";
import { logger } from "../logging";
import { redisStoreOf } from "../singletons/cache/stores";
import { closeRedisClient, createRedisClient } from "../utils/redis";

export type TokenRepository = {
  saveJti(jti: string, expiresIn: string): Promise<void>;
  isTokenUsed(jti: string): Promise<boolean>;
  /** `expiresIn` only applies to a JTI with no TTL of its own — see `revoke`. */
  revoke(jti: string, expiresIn: string): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  /** Both flags in one round trip — the refresh rotation reads them together. */
  checkRefresh(jti: string): Promise<{ isUsed: boolean; isRevoked: boolean }>;
  /** Readiness: whether every connection the store holds answers. */
  ping(): Promise<boolean>;
  close(): void;
};

export type TokenRepositoryClient = {
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hmget(key: string, fields: string[]): Promise<(string | null)[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  ping(): Promise<string>;
  close(): void;
};

/** `prefix` starts every record's key: a Redis store's `prefix` and its `:`. */
export const createTokenRepositoryWithClient = (
  client: TokenRepositoryClient,
  prefix = "",
): TokenRepository => {
  const log = logger("token-repository");

  const saveJti = async (jti: string, expiresIn: string) => {
    const key = `${prefix}${jti}`;
    try {
      await client.hset(key, { isUsed: "true" });
      await client.expire(key, parseDurationToMs(expiresIn) / 1000);
    } catch (error) {
      log.error({ err: error }, "failed to save JTI");
      throw new Error("Token storage unavailable");
    }
  };

  const isTokenUsed = async (jti: string): Promise<boolean> => {
    try {
      const [isUsed] = await client.hmget(`${prefix}${jti}`, ["isUsed"]);
      return isUsed === "true";
    } catch (error) {
      log.error({ err: error }, "failed to check JTI usage, failing closed");
      return true;
    }
  };

  const revoke = async (jti: string, expiresIn: string) => {
    const key = `${prefix}${jti}`;
    try {
      const [isUsed, isRevoked] = await client.hmget(key, ["isUsed", "isRevoked"]);
      if (isRevoked === "true") return;

      await client.hset(key, { isRevoked: "true" });

      // saveJti is the only writer of a TTL, so `isUsed` doubles as "this key
      // already expires on its own". Without one the revocation record would
      // outlive the token it revokes, forever — but overwriting an existing TTL
      // would move a refresh token's expiry, so only a fresh key gets one.
      if (isUsed !== "true") await client.expire(key, parseDurationToMs(expiresIn) / 1000);
    } catch (error) {
      log.error({ err: error }, "failed to revoke JTI");
      throw new Error("Token revocation failed");
    }
  };

  const isRevoked = async (jti: string): Promise<boolean> => {
    try {
      const [isRevoked] = await client.hmget(`${prefix}${jti}`, ["isRevoked"]);
      return isRevoked === "true";
    } catch (error) {
      log.error({ err: error }, "failed to check revocation, failing closed");
      return true;
    }
  };

  const checkRefresh = async (jti: string): Promise<{ isUsed: boolean; isRevoked: boolean }> => {
    try {
      const [isUsed, isRevoked] = await client.hmget(`${prefix}${jti}`, ["isUsed", "isRevoked"]);
      return { isUsed: isUsed === "true", isRevoked: isRevoked === "true" };
    } catch (error) {
      log.error({ err: error }, "failed to check JTI state, failing closed");
      return { isUsed: true, isRevoked: true };
    }
  };

  return {
    saveJti,
    isTokenUsed,
    revoke,
    isRevoked,
    checkRefresh,
    ping: async () => (await client.ping()) === "PONG",
    close: () => closeRedisClient(client),
  };
};

export const TOKEN_REPOSITORY_POOL_SIZE = 4;

/**
 * Spreads commands across the pool while keeping every command for one JTI on
 * the same connection: `saveJti` and `revoke` are multi-command sequences on
 * one key, and a per-command round-robin would let their halves land on
 * different sockets and reorder.
 */
export const createShardedTokenRepositoryClient = (
  clients: TokenRepositoryClient[],
): TokenRepositoryClient => {
  const clientFor = (key: string): TokenRepositoryClient => {
    const index = Number(BigInt(Bun.hash(key)) % BigInt(clients.length));
    return clients[index < 0 ? -index : index]!;
  };

  return {
    hset: (key, fields) => clientFor(key).hset(key, fields),
    hmget: (key, fields) => clientFor(key).hmget(key, fields),
    expire: (key, seconds) => clientFor(key).expire(key, seconds),
    ping: async () =>
      (await Promise.all(clients.map((pooled) => pooled.ping()))).find(
        (answer) => answer !== "PONG",
      ) ?? "PONG",
    close: () => {
      for (const pooled of clients) closeRedisClient(pooled);
    },
  };
};

// Bun retries a dropped connection 50 ms later, doubling the delay, so this
// covers a restart or a failover without holding a request past its timeout.
export const TOKEN_STORE_RECONNECT_WAIT_MS = 1_000;
const RECONNECT_POLL_MS = 10;

/**
 * createRedisClient fails a command at once while its connection is down, which
 * the cache and the rate limiter answer without Redis. The token store fails
 * closed instead, so a reconnect would serve every bearer token as revoked
 * meanwhile: a command that finds the connection down runs once more when it is
 * back, waiting at most `waitMs`. `ping` never waits, so readiness reports the
 * connection as it is.
 */
export const retryAfterReconnect = (
  client: TokenRepositoryClient & { readonly connected: boolean },
  waitMs = TOKEN_STORE_RECONNECT_WAIT_MS,
): TokenRepositoryClient => {
  const run = async <T>(command: () => Promise<T>): Promise<T> => {
    try {
      return await command();
    } catch (error) {
      if (client.connected) throw error;
      const deadline = performance.now() + waitMs;
      while (!client.connected && performance.now() < deadline) {
        await Bun.sleep(RECONNECT_POLL_MS);
      }
      return command();
    }
  };

  return {
    hset: (key, fields) => run(() => client.hset(key, fields)),
    hmget: (key, fields) => run(() => client.hmget(key, fields)),
    expire: (key, seconds) => run(() => client.expire(key, seconds)),
    ping: () => client.ping(),
    close: () => closeRedisClient(client),
  };
};

export const createTokenRepository = (redisUrl: string, prefix = ""): TokenRepository => {
  // Bun's RedisClient exposes the same hset/hmget/expire surface we need but
  // its declared types are wider than TokenRepositoryClient. The cast is the
  // structural-typing bridge and is intentional.
  const clients = Array.from({ length: TOKEN_REPOSITORY_POOL_SIZE }, () =>
    createRedisClient(redisUrl),
  ) as unknown as Array<TokenRepositoryClient & { readonly connected: boolean }>;

  return createTokenRepositoryWithClient(
    createShardedTokenRepositoryClient(clients.map((client) => retryAfterReconnect(client))),
    prefix,
  );
};

type MemoryRecord = { fields: Record<string, string>; expiresAt?: number };

// Swept at most this often, on a write: an expired record is otherwise dropped
// only when its own key is read again.
const MEMORY_SWEEP_MS = 60_000;

/**
 * JTI records kept in this process, for AUTH_STORE=memory. Another worker or
 * replica never sees them, and a restart forgets them all.
 */
export const createMemoryTokenRepositoryClient = (
  now: () => number = Date.now,
  records = new Map<string, MemoryRecord>(),
): TokenRepositoryClient => {
  let sweptAt = now();

  const live = (key: string) => {
    const record = records.get(key);
    if (record?.expiresAt !== undefined && record.expiresAt <= now()) {
      records.delete(key);
      return undefined;
    }
    return record;
  };

  const sweep = () => {
    if (now() - sweptAt < MEMORY_SWEEP_MS) return;
    sweptAt = now();
    for (const key of records.keys()) live(key);
  };

  return {
    hset: async (key, fields) => {
      sweep();
      const record = live(key) ?? { fields: {} };
      Object.assign(record.fields, fields);
      records.set(key, record);
    },
    hmget: async (key, fields) => {
      const record = live(key);
      return fields.map((field) => record?.fields[field] ?? null);
    },
    expire: async (key, seconds) => {
      const record = live(key);
      if (record) record.expiresAt = now() + seconds * 1000;
    },
    ping: async () => "PONG",
    close: () => records.clear(),
  };
};

export const createMemoryTokenRepository = (): TokenRepository =>
  createTokenRepositoryWithClient(createMemoryTokenRepositoryClient());

const AUTH_STORE_REQUIRED =
  "AUTH_STORE is required when auth is enabled: set it to memory (revocations stay in this process and are lost on restart) or to a redis store declared in caches.stores (shared by every process)";

/**
 * The token store AUTH_STORE names, required by the server when auth is on.
 * With auth off, or in the in-process engine (which passes `required: false`),
 * an unset AUTH_STORE keeps tokens in the process, while a set one is honoured:
 * a server that only verifies tokens another deployment issues then sees the
 * revocations that deployment records.
 */
export const createConfiguredTokenRepository = (
  authEnabled: boolean,
  authStore: string | undefined,
  caches: Configuration["caches"],
  required = true,
): TokenRepository => {
  if (authStore === undefined) {
    if (authEnabled && required) throw new Error(AUTH_STORE_REQUIRED);
    return createMemoryTokenRepository();
  }
  if (authStore === MEMORY_STORE) return createMemoryTokenRepository();
  const { url, prefix } = redisStoreOf(caches, "AUTH_STORE", authStore);
  return createTokenRepository(url, prefix);
};

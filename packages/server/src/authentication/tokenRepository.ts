import { RedisClient as ValkeyClient } from "bun";

import { parseDurationToMs } from "./duration";
import { logger } from "../logging";

export type TokenRepository = {
  saveJti(jti: string, expiresIn: string): Promise<void>;
  isTokenUsed(jti: string): Promise<boolean>;
  /** `expiresIn` only applies to a JTI with no TTL of its own — see `revoke`. */
  revoke(jti: string, expiresIn: string): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
};

export type TokenRepositoryClient = {
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hmget(key: string, fields: string[]): Promise<(string | null)[]>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export const createTokenRepositoryWithClient = (client: TokenRepositoryClient): TokenRepository => {
  const log = logger("token-repository");

  const saveJti = async (jti: string, expiresIn: string) => {
    try {
      await client.hset(jti, { isUsed: "true" });
      await client.expire(jti, parseDurationToMs(expiresIn) / 1000);
    } catch (error) {
      log.error({ err: error }, "failed to save JTI");
      throw new Error("Token storage unavailable");
    }
  };

  const isTokenUsed = async (jti: string): Promise<boolean> => {
    try {
      const [isUsed] = await client.hmget(jti, ["isUsed"]);
      return isUsed === "true";
    } catch (error) {
      log.error({ err: error }, "failed to check JTI usage, failing closed");
      return true;
    }
  };

  const revoke = async (jti: string, expiresIn: string) => {
    try {
      const [isUsed, isRevoked] = await client.hmget(jti, ["isUsed", "isRevoked"]);
      if (isRevoked === "true") return;

      await client.hset(jti, { isRevoked: "true" });

      // saveJti is the only writer of a TTL, so `isUsed` doubles as "this key
      // already expires on its own". Without one the revocation record would
      // outlive the token it revokes, forever — but overwriting an existing TTL
      // would move a refresh token's expiry, so only a fresh key gets one.
      if (isUsed !== "true") await client.expire(jti, parseDurationToMs(expiresIn) / 1000);
    } catch (error) {
      log.error({ err: error }, "failed to revoke JTI");
      throw new Error("Token revocation failed");
    }
  };

  const isRevoked = async (jti: string): Promise<boolean> => {
    try {
      const [isRevoked] = await client.hmget(jti, ["isRevoked"]);
      return isRevoked === "true";
    } catch (error) {
      log.error({ err: error }, "failed to check revocation, failing closed");
      return true;
    }
  };

  return {
    saveJti,
    isTokenUsed,
    revoke,
    isRevoked,
  };
};

export const createTokenRepository = (redisUrl: string): TokenRepository =>
  // Bun's RedisClient exposes the same hset/hmget/expire surface we need but
  // its declared types are wider than TokenRepositoryClient. The cast is the
  // structural-typing bridge and is intentional.
  createTokenRepositoryWithClient(new ValkeyClient(redisUrl) as unknown as TokenRepositoryClient);

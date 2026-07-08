import { timingSafeEqual } from "crypto";

import { decrypt, encrypt, sign, verify } from "paseto-ts/v4";

import type { Env } from "../types/env";
import type { SessionContext } from "../utils/sessionVariables";
import type { TokenRepository } from "./tokenRepository";
import type { TokenGenerationParameters, TokenOptions, TokenResponse, TokenService } from "./types";

import { parseDurationToSeconds, toPasetoDuration } from "./duration";
import { createTokenRepository } from "./tokenRepository";
import { logger } from "../logging";

// Audience constants to distinguish token types
const ACCESS_TOKEN_AUDIENCE = "access";
const REFRESH_TOKEN_AUDIENCE = "refresh";

// Timing-safe string comparison to prevent timing attacks
const safeCompare = (a: string, b: string): boolean => {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

type PasetoPayload = {
  sub: string;
  role: string;
  claims?: Record<string, unknown>;
  jti: string;
  aud?: string;
  iss?: string;
  iat?: string;
  exp?: string;
  nbf?: string;
};

/**
 * Convert PASETO ISO 8601 timestamp string to Unix epoch seconds
 */
const isoToEpoch = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  return Math.floor(new Date(iso).getTime() / 1000);
};

type PasetoMode = "local" | "public";

export const createPASETOService = (
  env: Env,
  mode: PasetoMode,
  tokenRepositoryOverride?: TokenRepository,
): TokenService => {
  const tokenRepository = tokenRepositoryOverride ?? createTokenRepository(env.cache.redisUrl);

  // Token creation and verification functions based on mode
  const createPasetoToken = async (
    payload: Record<string, unknown>,
    expiry: string,
  ): Promise<string> => {
    const pasetoPayload = {
      ...payload,
      exp: toPasetoDuration(expiry),
    };

    if (mode === "local") {
      return encrypt(env.paseto.localKey!, pasetoPayload);
    }
    return sign(env.paseto.secretKey!, pasetoPayload);
  };

  const verifyPasetoToken = async (token: string): Promise<PasetoPayload> => {
    if (mode === "local") {
      const { payload } = await decrypt<PasetoPayload>(env.paseto.localKey!, token);
      return payload;
    }
    const { payload } = await verify<PasetoPayload>(env.paseto.publicKey!, token);
    return payload;
  };

  const createToken = async (
    payload: TokenGenerationParameters,
    options: TokenOptions = {},
  ): Promise<string> => {
    try {
      const tokenPayload: Record<string, unknown> = {
        sub: payload.sub,
        role: payload.role,
        jti: crypto.randomUUID(),
      };

      if (payload.claims) {
        tokenPayload.claims = payload.claims;
      }
      if (options.audience) {
        tokenPayload.aud = options.audience;
      }
      if (options.issuer) {
        tokenPayload.iss = options.issuer;
      }

      const expiry = options.expiresIn || env.jwt.expiresIn;
      return await createPasetoToken(tokenPayload, expiry);
    } catch (error) {
      logger("auth").child({ strategy: "paseto" }).error({ err: error }, "token creation failed");
      throw new Error("Token creation failed");
    }
  };

  const verifyToken = async <T = PasetoPayload>(
    token: string,
    options: TokenOptions = {},
  ): Promise<T> => {
    const payload = await verifyPasetoToken(token);

    // Validate audience manually (PASETO doesn't auto-validate audience)
    if (options.audience && payload.aud !== options.audience) {
      throw new Error("Audience mismatch");
    }

    if (options.issuer && payload.iss !== options.issuer) {
      throw new Error("Issuer mismatch");
    }

    return payload as T;
  };

  const verifyTokenAndGetRole = async (
    authHeader: string | null,
    adminSecretHeader: string | null,
  ): Promise<string> => {
    if (env.admin.secret && adminSecretHeader && safeCompare(adminSecretHeader, env.admin.secret))
      return env.superadmin.role;

    if (!authHeader) return env.anonymousRole;

    if (!authHeader.startsWith("Bearer ")) return env.anonymousRole;

    const token = authHeader.substring(7);

    try {
      const payload = await verifyPasetoToken(token);
      return payload.role;
    } catch {
      return env.anonymousRole;
    }
  };

  const verifyTokenAndGetSession = async (
    authHeader: string | null,
    adminSecretHeader: string | null,
  ): Promise<SessionContext> => {
    if (env.admin.secret && adminSecretHeader && safeCompare(adminSecretHeader, env.admin.secret))
      return { sub: "superadmin", role: env.superadmin.role };

    if (!authHeader || !authHeader.startsWith("Bearer "))
      return { sub: "anonymous", role: env.anonymousRole };

    const token = authHeader.substring(7);

    try {
      const payload = await verifyPasetoToken(token);
      // Enforce access-token audience on the bearer path
      if (payload.aud && payload.aud !== ACCESS_TOKEN_AUDIENCE) {
        throw new Error("Audience mismatch");
      }
      if (await tokenRepository.isRevoked(payload.jti)) {
        logger("auth").child({ strategy: "paseto" }).warn({ jti: payload.jti }, "token revoked");
        return { sub: "anonymous", role: env.anonymousRole };
      }
      logger("auth")
        .child({ strategy: "paseto" })
        .debug({ sub: payload.sub, role: payload.role }, "token verified");
      return {
        sub: payload.sub,
        role: payload.role,
        jti: payload.jti,
        claims: payload.claims ?? {},
        iat: isoToEpoch(payload.iat),
        exp: isoToEpoch(payload.exp),
      };
    } catch (error) {
      logger("auth")
        .child({ strategy: "paseto" })
        .debug({ err: error }, "token verification failed");
      return { sub: "anonymous", role: env.anonymousRole };
    }
  };

  const createTokenPair = async (
    payload: TokenGenerationParameters,
    options: TokenOptions = {},
  ): Promise<TokenResponse> => {
    const accessTokenExpiry = options.expiresIn || env.jwt.expiresIn;

    const access_token = await createToken(payload, {
      ...options,
      expiresIn: accessTokenExpiry,
      audience: ACCESS_TOKEN_AUDIENCE,
    });

    const refresh_token = await createToken(payload, {
      ...options,
      expiresIn: env.jwt.rtExpiresIn,
      audience: REFRESH_TOKEN_AUDIENCE,
    });

    return {
      access_token,
      refresh_token,
      expires_in: parseDurationToSeconds(accessTokenExpiry),
      role: payload.role,
    };
  };

  const refreshAccessToken = async (refresh_token: string): Promise<TokenResponse> => {
    const payload = await verifyToken<PasetoPayload>(refresh_token, {
      audience: REFRESH_TOKEN_AUDIENCE,
    });

    if (await tokenRepository.isRevoked(payload.jti)) {
      throw new Error("Token revoked");
    }

    const isAlreadyUsed = await tokenRepository.isTokenUsed(payload.jti);

    if (isAlreadyUsed) {
      throw new Error("Token reuse detected");
    }

    await tokenRepository.saveJti(payload.jti, env.jwt.rtExpiresIn);

    return createTokenPair(
      {
        sub: payload.sub,
        role: payload.role,
        claims: payload.claims ?? {},
      },
      { expiresIn: env.jwt.expiresIn },
    );
  };

  return {
    createToken,
    verifyToken,
    verifyTokenAndGetRole,
    verifyTokenAndGetSession,
    createTokenPair,
    refreshAccessToken,
    revoke: tokenRepository.revoke,
    isRevoked: tokenRepository.isRevoked,
  };
};

import { timingSafeEqual } from "crypto";

import { SignJWT, jwtVerify } from "jose";

import type { JWTPayload } from "jose";
import type { Env } from "../types/env";
import type { SessionContext } from "../utils/sessionVariables";
import type { TokenRepository } from "./tokenRepository";
import type { TokenGenerationParameters, TokenOptions, TokenResponse, TokenService } from "./types";

import { parseDurationToSeconds } from "./duration";
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

export type { TokenGenerationParameters, TokenOptions, TokenResponse };

export type JWTTokenPayload = JWTPayload &
  TokenGenerationParameters & {
    jti: string;
  };

const ALGORITHM = "HS256";
const TYP = "JWT";

export const createJWTService = (
  env: Env,
  tokenRepositoryOverride?: TokenRepository,
): TokenService => {
  const tokenRepository = tokenRepositoryOverride ?? createTokenRepository(env.cache.redisUrl);
  const jwtSecret = new TextEncoder().encode(env.jwt.secret);

  const createToken = async (
    payload: TokenGenerationParameters,
    options: TokenOptions = {},
  ): Promise<string> => {
    try {
      const jwt = new SignJWT({ ...payload })
        .setProtectedHeader({ alg: ALGORITHM, typ: TYP })
        .setIssuedAt()
        .setSubject(payload.sub)
        .setExpirationTime(options.expiresIn || env.jwt.expiresIn)
        .setJti(crypto.randomUUID()); // Add unique token ID

      if (options.issuer) {
        jwt.setIssuer(options.issuer);
      }
      if (options.audience) {
        jwt.setAudience(options.audience);
      }
      if (options.notBefore) {
        jwt.setNotBefore(options.notBefore);
      }

      return await jwt.sign(jwtSecret);
    } catch (error) {
      logger("auth").child({ strategy: "jwt" }).error({ err: error }, "token creation failed");
      throw new Error("Token creation failed");
    }
  };

  const verifyToken = async <T extends JWTTokenPayload = JWTTokenPayload>(
    token: string,
    options: TokenOptions = {},
  ): Promise<T> => {
    const { payload } = await jwtVerify(token, jwtSecret, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: [ALGORITHM],
      typ: TYP,
    });

    return payload as T;
  };

  const verifyTokenAndGetRole = async (
    authHeader: string | null,
    adminSecretHeader: string | null,
  ): Promise<string> => {
    // Use timing-safe comparison to prevent timing attacks
    if (env.admin.secret && adminSecretHeader && safeCompare(adminSecretHeader, env.admin.secret))
      return env.superadmin.role;

    if (!authHeader) return env.anonymousRole;

    if (!authHeader.startsWith("Bearer ")) return env.anonymousRole;

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
      const verifiedToken = await verifyToken(token);

      return verifiedToken.role;
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
      const payload = await verifyToken(token, { audience: ACCESS_TOKEN_AUDIENCE });
      if (await tokenRepository.isRevoked(payload.jti)) {
        logger("auth").child({ strategy: "jwt" }).warn({ jti: payload.jti }, "token revoked");
        return { sub: "anonymous", role: env.anonymousRole };
      }
      logger("auth")
        .child({ strategy: "jwt" })
        .debug({ sub: payload.sub, role: payload.role }, "token verified");
      return {
        sub: payload.sub,
        role: payload.role,
        jti: payload.jti,
        claims: (payload.claims as Record<string, unknown>) ?? {},
        iat: payload.iat,
        exp: payload.exp,
      };
    } catch (error) {
      logger("auth").child({ strategy: "jwt" }).debug({ err: error }, "token verification failed");
      return { sub: "anonymous", role: env.anonymousRole };
    }
  };

  const createTokenPair = async (
    payload: TokenGenerationParameters,
    options: TokenOptions = {},
  ): Promise<TokenResponse> => {
    const accessTokenExpiry = options.expiresIn || env.jwt.expiresIn;

    // Access token - short lived, with "access" audience
    const access_token = await createToken(payload, {
      ...options,
      expiresIn: accessTokenExpiry,
      audience: ACCESS_TOKEN_AUDIENCE,
    });

    // Refresh token - longer lived, with "refresh" audience
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

  const refreshAccessToken = async (refresh_token: string) => {
    // Verify refresh token with correct audience
    const payload = await verifyToken(refresh_token, {
      audience: REFRESH_TOKEN_AUDIENCE,
    });

    if (await tokenRepository.isRevoked(payload.jti)) {
      throw new Error("Token revoked");
    }

    // Check if this refresh token has already been used (token rotation)
    const isAlreadyUsed = await tokenRepository.isTokenUsed(payload.jti);

    if (isAlreadyUsed) {
      // Token reuse detected - this could indicate token theft
      // In a production system, you might want to revoke all tokens for this user
      throw new Error("Token reuse detected");
    }

    // Mark this refresh token as used BEFORE issuing new tokens
    await tokenRepository.saveJti(payload.jti, env.jwt.rtExpiresIn);

    // Create new token pair with original subject, role, and claims
    return createTokenPair(
      {
        sub: payload.sub,
        role: payload.role,
        claims: (payload.claims as Record<string, unknown>) ?? {},
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

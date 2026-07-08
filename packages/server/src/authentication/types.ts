import type { SessionContext } from "../utils/sessionVariables";

// ============================================================================
// Token Strategy
// ============================================================================

export type TokenStrategy = "jwt" | "paseto_local" | "paseto_public";

// ============================================================================
// Shared Token Types
// ============================================================================

export type TokenGenerationParameters = {
  sub: string;
  role: string;
  claims?: Record<string, unknown>;
};

export type TokenPayload = {
  sub: string;
  role: string;
  claims?: Record<string, unknown>;
  jti: string;
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
};

export type TokenOptions = {
  expiresIn?: string;
  issuer?: string;
  audience?: string;
  notBefore?: string | number;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds until access_token expires
  role: string;
};

// ============================================================================
// Token Service Interface
// ============================================================================

export type TokenService = {
  createToken(payload: TokenGenerationParameters, options?: TokenOptions): Promise<string>;

  verifyToken<T extends TokenPayload = TokenPayload>(
    token: string,
    options?: TokenOptions,
  ): Promise<T>;

  verifyTokenAndGetRole(
    authHeader: string | null,
    adminSecretHeader: string | null,
  ): Promise<string>;

  verifyTokenAndGetSession(
    authHeader: string | null,
    adminSecretHeader: string | null,
  ): Promise<SessionContext>;

  createTokenPair(
    payload: TokenGenerationParameters,
    options?: TokenOptions,
  ): Promise<TokenResponse>;

  refreshAccessToken(refresh_token: string): Promise<TokenResponse>;

  revoke(jti: string): Promise<void>;

  isRevoked(jti: string): Promise<boolean>;
};

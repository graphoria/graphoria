import type { Env } from "../types/env";
import type { TokenService, TokenStrategy } from "./types";

import { createJWTService } from "./jwt";
import { createPASETOService } from "./paseto";

export const createTokenService = (env: Env, strategy: TokenStrategy = "jwt"): TokenService => {
  switch (strategy) {
    case "jwt": {
      if (!env.jwt.secret) {
        throw new Error(
          "JWT_SECRET environment variable is required when using jwt token strategy",
        );
      }
      return createJWTService(env);
    }
    case "paseto_local": {
      if (!env.paseto.localKey) {
        throw new Error(
          "PASETO_LOCAL_KEY environment variable is required when using paseto_local token strategy.",
        );
      }
      return createPASETOService(env, "local");
    }
    case "paseto_public": {
      if (!env.paseto.secretKey || !env.paseto.publicKey) {
        throw new Error(
          "PASETO_SECRET_KEY and PASETO_PUBLIC_KEY environment variables are required when using paseto_public token strategy.",
        );
      }
      return createPASETOService(env, "public");
    }
  }
};

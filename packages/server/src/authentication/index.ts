import type { Env } from "../types/env";
import type { TokenService, TokenStrategy } from "./types";

import { createJWTService } from "./jwt";
import { createPASETOService } from "./paseto";
import { logger } from "../logging";

const warnNoKey = (strategy: TokenStrategy, variable: string) =>
  logger("auth").warn(
    { strategy },
    `${variable} is not set: bearer tokens are ignored, since auth and the console are off`,
  );

/**
 * `keyRequired` is false when nothing signs tokens (auth and the console both
 * off). A missing key then builds a service that verifies nothing, so every
 * bearer token is anonymous.
 */
export const createTokenService = (
  env: Env,
  strategy: TokenStrategy = "jwt",
  keyRequired = true,
): TokenService => {
  switch (strategy) {
    case "jwt": {
      if (env.jwt.secrets.length === 0) {
        if (keyRequired) {
          throw new Error(
            "JWT_SECRET environment variable is required by the jwt token strategy when auth or the console is enabled",
          );
        }
        warnNoKey(strategy, "JWT_SECRET");
      }
      return createJWTService(env);
    }
    case "paseto_local": {
      if (env.paseto.localKeys.length === 0) {
        if (keyRequired) {
          throw new Error(
            "PASETO_LOCAL_KEY environment variable is required by the paseto_local token strategy when auth or the console is enabled.",
          );
        }
        warnNoKey(strategy, "PASETO_LOCAL_KEY");
      }
      return createPASETOService(env, "local");
    }
    case "paseto_public": {
      if (keyRequired && (!env.paseto.secretKey || env.paseto.publicKeys.length === 0)) {
        throw new Error(
          "PASETO_SECRET_KEY and PASETO_PUBLIC_KEY environment variables are required by the paseto_public token strategy when auth or the console is enabled.",
        );
      }
      // Verifying needs only the public keys, so a missing secret key alone costs nothing here.
      if (!keyRequired && env.paseto.publicKeys.length === 0) {
        warnNoKey(strategy, "PASETO_PUBLIC_KEY");
      }
      return createPASETOService(env, "public");
    }
  }
};

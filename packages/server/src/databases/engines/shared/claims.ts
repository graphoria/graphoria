import { logger } from "../../../logging";

// Returns null when the stored claims are malformed — callers must reject the login
// (fail closed) rather than issue a token with missing claims.
export const parseUserClaims = (claims: unknown): Record<string, unknown> | null => {
  if (claims === null || claims === undefined) return {};

  if (typeof claims === "object" && !Array.isArray(claims)) {
    return claims as Record<string, unknown>;
  }

  if (typeof claims === "string") {
    try {
      const parsed: unknown = JSON.parse(claims);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logger("auth").warn({ err: error }, "failed to parse user claims");
      return null;
    }
  }

  logger("auth").warn("user claims are not a JSON object");
  return null;
};

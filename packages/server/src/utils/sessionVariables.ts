/**
 * Session variable replacement utility
 * Replaces $session.* placeholders with actual values from token claims
 */

export type SessionContext = {
  role?: string;
  sub?: string;
  claims?: Record<string, unknown>;
  jti?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
};

const resolveDotPath = (obj: Record<string, unknown>, path: string): unknown => {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
};

/**
 * Replace session variables in a filter object
 * Converts values like "$session.userId" to actual claim values
 * Supports operator-based structure matching GraphQL where arguments
 *
 * @param filter - Filter object with potential session variables
 * @param session - JWT payload containing user session data
 * @returns Filter object with session variables replaced
 *
 * @example
 * ```typescript
 * const filter = {
 *   userId: { eq: "$session.sub" },
 *   age: { gte: 18, lt: 65 },
 *   organizationId: { eq: "$session.organizationId" }
 * };
 * const session = { sub: "123", organizationId: "org-456" };
 * const result = replaceSessionVariables(filter, session);
 * // result: { userId: { eq: "123" }, age: { gte: 18, lt: 65 }, organizationId: { eq: "org-456" } }
 * ```
 */
export const replaceSessionVariables = (
  filter: Record<string, unknown>,
  session: SessionContext | null,
): Record<string, unknown> => {
  if (!filter || !session) {
    return filter;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filter)) {
    // Handle operator-based structure (e.g., { eq: "$session.sub", gt: 10 })
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const operatorObj = value as Record<string, unknown>;
      const processedOperators: Record<string, unknown> = {};

      for (const [operator, operatorValue] of Object.entries(operatorObj)) {
        // Replace session variables in operator values
        if (typeof operatorValue === "string" && operatorValue.startsWith("$session.")) {
          const claimPath = operatorValue.substring(9);
          const sessionValue = resolveDotPath(session, claimPath);

          if (sessionValue === undefined) {
            throw new Error(
              `Session variable ${operatorValue} not found in JWT claims. Available claims: ${Object.keys(session).join(", ")}`,
            );
          }

          processedOperators[operator] = sessionValue;
        }
        // Recursively handle nested objects
        else if (
          typeof operatorValue === "object" &&
          operatorValue !== null &&
          !Array.isArray(operatorValue)
        ) {
          processedOperators[operator] = replaceSessionVariables(
            operatorValue as Record<string, unknown>,
            session,
          );
        }
        // Keep other values as-is
        else {
          processedOperators[operator] = operatorValue;
        }
      }

      result[key] = processedOperators;
    }
    // Keep other values as-is
    else {
      result[key] = value;
    }
  }

  return result;
};

/**
 * Check if a filter contains session variables
 * Supports both simple values and operator-based structure
 *
 * @param filter - Filter object to check
 * @returns true if filter contains $session.* variables
 */
export const hasSessionVariables = (filter: Record<string, unknown>): boolean => {
  for (const value of Object.values(filter)) {
    if (typeof value === "string" && value.startsWith("$session.")) {
      return true;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (hasSessionVariables(value as Record<string, unknown>)) {
        return true;
      }
    }
  }
  return false;
};

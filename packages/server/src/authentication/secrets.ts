import { timingSafeEqual } from "crypto";

import { logger } from "../logging";

// Timing-safe string comparison to prevent timing attacks
export const safeCompare = (a: string, b: string): boolean => {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
};

/**
 * True when `candidate` equals any entry of a rotating secret set. The first
 * entry is the current secret; a match further along means a caller still
 * holds a previous one, which is logged so the operator knows when it is safe
 * to drop it.
 */
export const matchesAnySecret = (candidate: string | null, secrets: string[]): boolean => {
  if (!candidate) return false;

  const index = secrets.findIndex((secret) => safeCompare(candidate, secret));
  if (index > 0) logger("auth").debug({ index }, "matched a previous secret");

  return index >= 0;
};

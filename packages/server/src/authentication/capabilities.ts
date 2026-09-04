import type { Env } from "../types/env";

import { logger } from "../logging";
import { matchesAnySecret } from "./secrets";

export type Capability = "console:read" | "console:write" | "ai" | "mcp";

/** `superset` is true when the admin secret, not a scoped credential, matched. */
export type CapabilityGrant = { superset: boolean };

export type CapabilityAuthorizer = (
  candidate: string | null,
  capability: Capability,
) => CapabilityGrant | null;

type WarnLog = { warn: (obj: object, msg: string) => void };

// Each list is checked on its own so the rotation debug line inside
// matchesAnySecret keeps reporting the index within one credential.
const scopedSecretsFor = (env: Env, capability: Capability): string[][] => {
  switch (capability) {
    case "console:read":
      return [env.console.writeSecrets, env.console.readSecrets];
    case "console:write":
      return [env.console.writeSecrets];
    case "ai":
      return [env.ai.secrets];
    case "mcp":
      return [env.ai.mcp.secrets];
  }
};

/**
 * Decides whether a presented secret grants a capability. The admin secret
 * grants all of them and is reported as the superset so the caller can tell
 * the two apart; it is also logged, since a scoped credential would have done.
 */
export const createCapabilityAuthorizer = (
  env: Env,
  log: WarnLog = logger("auth"),
): CapabilityAuthorizer => {
  return (candidate, capability) => {
    if (matchesAnySecret(candidate, env.admin.secrets)) {
      log.warn({ capability }, "admin secret used where a scoped credential would do");
      return { superset: true };
    }

    for (const secrets of scopedSecretsFor(env, capability)) {
      if (matchesAnySecret(candidate, secrets)) return { superset: false };
    }

    return null;
  };
};

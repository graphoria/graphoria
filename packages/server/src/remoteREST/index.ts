import type { RemoteRESTConfig } from "../config";
import type { RemoteRESTResolved } from "./types";

import { parseRemoteOpenAPI } from "./parse";
import { transformRemoteREST } from "./transform";
import { logger } from "../logging";

/**
 * Resolve a single remote REST API: parse spec → transform → produce RemoteRESTResolved
 */
export const resolveRemoteREST = async (config: RemoteRESTConfig): Promise<RemoteRESTResolved> => {
  const spec = await parseRemoteOpenAPI(config);
  return transformRemoteREST(spec, config);
};

/**
 * Resolve all enabled remote REST APIs in parallel.
 * Returns an array of successfully resolved APIs; logs warnings for failures.
 */
export const resolveRemoteRESTApis = async (
  configs: RemoteRESTConfig[],
): Promise<RemoteRESTResolved[]> => {
  const enabled = configs.filter((c) => c.enabled !== false);

  if (enabled.length === 0) return [];

  const results = await Promise.allSettled(enabled.map((config) => resolveRemoteREST(config)));

  const resolved: RemoteRESTResolved[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      resolved.push(result.value);
    } else {
      logger("remote-rest").warn(
        { api: enabled[i].name, err: result.reason },
        "failed to resolve remote REST API",
      );
    }
  }

  return resolved;
};

export type { RemoteRESTResolved } from "./types";

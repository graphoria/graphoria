import type { RemoteSchemaConfig } from "../config";
import type { RemoteSchemaResolved } from "./types";

import { introspectRemoteSchema } from "./introspect";
import { transformRemoteSchema } from "./transform";
import { logger } from "../logging";

/**
 * Resolve a single remote schema: introspect → transform → produce RemoteSchemaResolved
 */
export const resolveRemoteSchema = async (
  config: RemoteSchemaConfig,
): Promise<RemoteSchemaResolved> => {
  const schema = await introspectRemoteSchema(config);
  return transformRemoteSchema(schema, config);
};

/**
 * Resolve all enabled remote schemas in parallel.
 * Returns an array of successfully resolved schemas; logs warnings for failures.
 */
export const resolveRemoteSchemas = async (
  configs: RemoteSchemaConfig[],
): Promise<RemoteSchemaResolved[]> => {
  const enabled = configs.filter((c) => c.enabled !== false);

  if (enabled.length === 0) return [];

  const results = await Promise.allSettled(enabled.map((config) => resolveRemoteSchema(config)));

  const resolved: RemoteSchemaResolved[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      resolved.push(result.value);
    } else {
      logger("remote-schemas").warn(
        { schema: enabled[i].name, err: result.reason },
        "failed to introspect remote schema",
      );
    }
  }

  return resolved;
};

export type { RemoteSchemaResolved } from "./types";

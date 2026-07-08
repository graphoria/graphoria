import { buildClientSchema, getIntrospectionQuery } from "graphql";

import type { RemoteSchemaConfig } from "../config";
import type { GraphQLSchema, IntrospectionQuery } from "graphql";

/**
 * Send an introspection query to a remote GraphQL endpoint and return the parsed schema.
 */
export const introspectRemoteSchema = async (
  config: RemoteSchemaConfig,
): Promise<GraphQLSchema> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout ?? 10000);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: getIntrospectionQuery() }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Remote schema "${config.name}" introspection failed: HTTP ${response.status}`,
      );
    }

    const json = (await response.json()) as { data?: IntrospectionQuery };

    if (!json.data) {
      throw new Error(`Remote schema "${config.name}" introspection returned no data`);
    }

    return buildClientSchema(json.data);
  } finally {
    clearTimeout(timeoutId);
  }
};

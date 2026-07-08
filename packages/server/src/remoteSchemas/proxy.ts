import type { SelectionAnalysis } from "../analyzeQuery/types";
import type { RemoteSchemaResolved } from "./types";

/**
 * Build the sub-query string for a remote field by stripping the prefix from
 * the field name and type references.
 */
const buildRemoteSubQuery = (
  field: SelectionAnalysis,
  originalFieldName: string,
  prefixMap: RemoteSchemaResolved["prefixMap"],
): string => {
  const args = buildArgumentsString(field.arguments);
  const selections = field.selections?.length
    ? ` { ${buildSelectionsString(field.selections, prefixMap)} }`
    : "";

  return `${originalFieldName}${args}${selections}`;
};

/**
 * Recursively build a selections string, un-prefixing any type references in inline fragments.
 */
const buildSelectionsString = (
  selections: SelectionAnalysis[],
  prefixMap: RemoteSchemaResolved["prefixMap"],
): string =>
  selections
    .map((sel) => {
      const subSelections = sel.selections?.length
        ? ` { ${buildSelectionsString(sel.selections, prefixMap)} }`
        : "";

      const aliasPrefix = sel.alias ? `${sel.alias}: ` : "";
      return `${aliasPrefix}${sel.name}${buildArgumentsString(sel.arguments)}${subSelections}`;
    })
    .join(" ");

/**
 * Serialize arguments back to GraphQL argument syntax.
 */
const buildArgumentsString = (args: Record<string, unknown> | undefined): string => {
  if (!args || Object.keys(args).length === 0) return "";

  const parts = Object.entries(args).map(([key, value]) => `${key}: ${serializeValue(value)}`);

  return `(${parts.join(", ")})`;
};

/**
 * Serialize a value to GraphQL literal syntax.
 */
const serializeValue = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${serializeValue(v)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return String(value);
};

/**
 * Build headers for the remote request by merging:
 * 1. Static headers from configuration
 * 2. Forwarded headers from the client request
 */
const buildHeaders = (
  config: RemoteSchemaResolved["config"],
  clientRequest?: Request,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };

  if (clientRequest && config.forwardHeaders?.length) {
    for (const headerName of config.forwardHeaders) {
      const value = clientRequest.headers.get(headerName);
      if (value) {
        headers[headerName] = value;
      }
    }
  }

  return headers;
};

/**
 * Execute a proxied GraphQL query/mutation against a remote schema endpoint.
 */
export const proxyRemoteField = async (
  field: SelectionAnalysis,
  remoteSchema: RemoteSchemaResolved,
  originalFieldName: string,
  variables: Record<string, unknown>,
  operationType: "query" | "mutation",
  clientRequest?: Request,
): Promise<unknown> => {
  const subQuery = buildRemoteSubQuery(field, originalFieldName, remoteSchema.prefixMap);

  const fullQuery = `${operationType} { ${subQuery} }`;

  const headers = buildHeaders(remoteSchema.config, clientRequest);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), remoteSchema.config.timeout ?? 10000);

  try {
    const response = await fetch(remoteSchema.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: fullQuery,
        variables,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Remote schema "${remoteSchema.config.name}" returned HTTP ${response.status}`,
      );
    }

    const json = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(
        `Remote schema "${remoteSchema.config.name}" error: ${json.errors[0].message}`,
      );
    }

    // Extract the result for the original field name
    return json.data?.[originalFieldName] ?? null;
  } finally {
    clearTimeout(timeoutId);
  }
};

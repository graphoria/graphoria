import { assertName } from "graphql";

import type { SelectionAnalysis } from "../analyzeQuery/types";
import type { RemoteSchemaResolved } from "./types";

import { formatTraceparent, startSpan } from "../observability/tracing";

type CallerValues = Record<string, unknown>;

/**
 * Build the sub-query string for a remote field, under its name on the remote.
 */
const buildRemoteSubQuery = (
  field: SelectionAnalysis,
  originalFieldName: string,
  variables: CallerValues,
): string => {
  const args = buildArgumentsString(field.arguments, variables);

  return `${originalFieldName}${args}${buildSelectionSet(field.selections, variables)}`;
};

/**
 * A selection set, or nothing for a scalar. A field whose every subfield a
 * directive excluded still needs one upstream, so it asks for `__typename`.
 */
const buildSelectionSet = (
  selections: SelectionAnalysis[] | undefined,
  variables: CallerValues,
): string => {
  if (!selections) return "";
  return ` { ${selections.length > 0 ? buildSelectionsString(selections, variables) : "__typename"} }`;
};

/**
 * Recursively build a selections string.
 */
const buildSelectionsString = (selections: SelectionAnalysis[], variables: CallerValues): string =>
  selections
    .map((sel) => {
      const aliasPrefix = sel.alias ? `${sel.alias}: ` : "";
      return `${aliasPrefix}${sel.name}${buildArgumentsString(sel.arguments, variables)}${buildSelectionSet(sel.selections, variables)}`;
    })
    .join(" ");

/**
 * Serialize arguments back to GraphQL argument syntax.
 */
const buildArgumentsString = (
  args: Record<string, unknown> | undefined,
  variables: CallerValues,
): string => {
  if (!args || Object.keys(args).length === 0) return "";

  const parts = Object.entries(args).map(
    ([key, value]) => `${key}: ${serializeValue(value, variables)}`,
  );

  return `(${parts.join(", ")})`;
};

/**
 * Serialize a value to GraphQL literal syntax. The analysis records a variable
 * as its `$name`; what a variable holds is data, so it is not looked up again.
 */
const serializeValue = (value: unknown, variables: CallerValues): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return value.startsWith("$") && Object.hasOwn(variables, value.slice(1))
      ? serializeValue(variables[value.slice(1)], {})
      : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValue(item, variables)).join(", ")}]`;
  }
  if (typeof value === "object") {
    // A key comes from the caller's variables too, and is written unquoted.
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${assertName(k)}: ${serializeValue(v, variables)}`,
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
 * The remote answers `__typename` with its own type names, which the merged
 * schema serves prefixed. Walks the result along the selection, aliases
 * included, renaming in place. A `__typename` the proxy added to an empty
 * selection set is removed: the caller selected nothing there.
 */
const prefixTypenames = (
  value: unknown,
  selections: SelectionAnalysis[] | undefined,
  toPrefixed: RemoteSchemaResolved["prefixMap"]["toPrefixed"],
): void => {
  if (!selections || value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) prefixTypenames(item, selections, toPrefixed);
    return;
  }

  const object = value as Record<string, unknown>;
  if (selections.length === 0) delete object["__typename"];

  for (const selection of selections) {
    const key = selection.alias || selection.name;
    const selected = object[key];

    if (selection.name === "__typename") {
      if (typeof selected === "string" && Object.hasOwn(toPrefixed, selected)) {
        object[key] = toPrefixed[selected];
      }
    } else {
      prefixTypenames(selected, selection.selections, toPrefixed);
    }
  }
};

/**
 * Execute a proxied GraphQL query/mutation against a remote schema endpoint.
 * `variables` are the caller's own, written into the query as values: what the
 * server binds for SQL (role-filter constants, `$session` claims) stays here.
 */
export const proxyRemoteField = async (
  field: SelectionAnalysis,
  remoteSchema: RemoteSchemaResolved,
  originalFieldName: string,
  variables: CallerValues,
  operationType: "query" | "mutation",
  clientRequest?: Request,
): Promise<unknown> => {
  const subQuery = buildRemoteSubQuery(field, originalFieldName, variables);

  const fullQuery = `${operationType} { ${subQuery} }`;

  const headers = buildHeaders(remoteSchema.config, clientRequest);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), remoteSchema.config.timeout ?? 10000);

  // The host only: a remote URL's path and query string carry caller data.
  const span = startSpan("graphoria.remote_schema", {
    kind: "client",
    attributes: {
      "http.request.method": "POST",
      "server.address": new URL(remoteSchema.config.url).host,
    },
  });
  if (span) headers["traceparent"] = formatTraceparent(span.context);

  try {
    const response = await fetch(remoteSchema.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: fullQuery }),
      signal: controller.signal,
    });
    span?.setAttribute("http.response.status_code", response.status);

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
    const result = json.data?.[originalFieldName] ?? null;
    prefixTypenames(result, field.selections, remoteSchema.prefixMap.toPrefixed);
    return result;
  } catch (error) {
    span?.recordError(error);
    throw error;
  } finally {
    span?.end();
    clearTimeout(timeoutId);
  }
};

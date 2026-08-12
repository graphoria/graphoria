// ============================================================================
// Minimal GraphQL-over-fetch transport for built-in auth mutations.
// Not exposed publicly — users bring their own GraphQL client for app queries.
// ============================================================================

export interface GraphQLError {
  message: string;
  extensions?: Record<string, unknown>;
  path?: ReadonlyArray<string | number>;
}

export class GraphQLFetchError extends Error {
  status: number;
  body: string;
  errors?: GraphQLError[];

  constructor(message: string, status: number, body: string, errors?: GraphQLError[]) {
    super(message);
    this.name = "GraphQLFetchError";
    this.status = status;
    this.body = body;
    this.errors = errors;
  }
}

interface GqlFetchOptions {
  bearer?: string | null;
  credentials?: boolean;
  signal?: AbortSignal;
}

interface GqlResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export async function gqlFetch<T>(
  uri: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  opts: GqlFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;

  const res = await fetch(uri, {
    method: "POST",
    headers,
    credentials: opts.credentials === false ? "same-origin" : "include",
    body: JSON.stringify({ query, variables }),
    signal: opts.signal,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new GraphQLFetchError(`GraphQL request failed: ${res.status}`, res.status, text);
  }

  let parsed: GqlResponse<T>;
  try {
    parsed = JSON.parse(text) as GqlResponse<T>;
  } catch {
    throw new GraphQLFetchError("Invalid JSON response", res.status, text);
  }

  if (parsed.errors && parsed.errors.length > 0) {
    throw new GraphQLFetchError(
      parsed.errors[0]?.message ?? "GraphQL error",
      res.status,
      text,
      parsed.errors,
    );
  }

  if (parsed.data === undefined) {
    throw new GraphQLFetchError("Empty GraphQL response", res.status, text);
  }

  return parsed.data;
}

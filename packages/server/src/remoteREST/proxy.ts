import type { RemoteRESTResolved, RemoteRESTRoute } from "./types";

/**
 * Build headers for the remote request by merging:
 * 1. Static headers from configuration
 * 2. Forwarded headers from the client request
 */
const buildHeaders = (
  resolved: RemoteRESTResolved,
  clientRequest: Request,
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...(resolved.config.headers ?? {}),
  };

  if (resolved.config.forwardHeaders?.length) {
    for (const headerName of resolved.config.forwardHeaders) {
      const value = clientRequest.headers.get(headerName);
      if (value) {
        headers[headerName] = value;
      }
    }
  }

  return headers;
};

/**
 * Convert an OpenAPI path template to a URL by substituting path parameters.
 * e.g. /users/{id} with { id: "123" } → /users/123
 */
const substitutePathParams = (path: string, params: Record<string, string>): string =>
  path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(value);
  });

/**
 * Proxy a request to a remote REST API endpoint.
 */
export const proxyRemoteRESTRequest = async (
  route: RemoteRESTRoute,
  resolved: RemoteRESTResolved,
  clientRequest: Request,
  pathParams: Record<string, string>,
  queryString: string,
): Promise<Response> => {
  const targetPath = substitutePathParams(route.originalPath, pathParams);
  const targetUrl = `${resolved.baseUrl}${targetPath}${queryString ? `?${queryString}` : ""}`;

  const headers = buildHeaders(resolved, clientRequest);

  // Forward content-type from the client request if present
  const contentType = clientRequest.headers.get("content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), resolved.config.timeout ?? 10000);

  try {
    const fetchInit: RequestInit = {
      method: route.method.toUpperCase(),
      headers,
      signal: controller.signal,
    };

    // Forward body for methods that support it
    if (clientRequest.body && ["post", "put", "patch"].includes(route.method)) {
      fetchInit.body = clientRequest.body;
      // @ts-expect-error: Bun supports duplex for streaming
      fetchInit.duplex = "half";
    }

    const response = await fetch(targetUrl, fetchInit);

    // Return the response with the same status and body
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

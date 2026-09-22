import { isTracingEnabled, parseTraceparent, startSpan, withActiveSpan } from "./tracing";

/**
 * Wraps a route handler so the request roots a trace. The span is named for the
 * mounted route, never the URL: a path carries identifiers and a query string
 * carries caller data, and a span name is exported verbatim.
 *
 * An inbound `traceparent` is continued, so a gateway's span and this one join
 * up. `parent: null` is deliberate — a request is a root, never a child of
 * whatever context the server happened to be in.
 */
export const withHttpTracing =
  <Req extends Request, Args extends unknown[]>(
    route: string,
    handler: (req: Req, ...args: Args) => Response | undefined | Promise<Response | undefined>,
  ) =>
  async (req: Req, ...args: Args): Promise<Response | undefined> => {
    if (!isTracingEnabled()) return handler(req, ...args);

    const url = new URL(req.url);
    const span = startSpan(`${req.method} ${route}`, {
      kind: "server",
      parent: parseTraceparent(req.headers.get("traceparent")) ?? null,
      attributes: {
        "http.request.method": req.method,
        "http.route": route,
        "url.scheme": url.protocol.replace(":", ""),
        "server.address": url.host,
      },
    });

    return withActiveSpan(span, async () => {
      try {
        const response = await handler(req, ...args);
        // A websocket upgrade answers no request, so it gets no span: leaving
        // this one unended is what keeps it out of the export.
        if (response) {
          span?.setAttribute("http.response.status_code", response.status);
          span?.end();
        }
        return response;
      } catch (error) {
        span?.recordError(error);
        span?.end();
        throw error;
      }
    });
  };

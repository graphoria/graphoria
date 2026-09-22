import { incMetric, isMetricsEnabled, observeMetric } from "./metrics";

/**
 * Wraps a route handler so the request is counted and timed. The route label is
 * the name of the mounted route, never the URL: a path carries identifiers, and
 * one series per identifier is a cardinality leak.
 */
export const withHttpMetrics =
  <Req extends Request, Args extends unknown[]>(
    route: string,
    handler: (req: Req, ...args: Args) => Response | undefined | Promise<Response | undefined>,
  ) =>
  async (req: Req, ...args: Args): Promise<Response | undefined> => {
    if (!isMetricsEnabled()) return handler(req, ...args);

    const startTime = Bun.nanoseconds();
    const method = req.method;
    const record = (status: string) => {
      incMetric("graphoria_http_requests_total", { route, method, status });
      observeMetric(
        "graphoria_http_request_duration_seconds",
        { route, method },
        (Bun.nanoseconds() - startTime) / 1e9,
      );
    };

    try {
      const response = await handler(req, ...args);
      // A websocket upgrade answers no request, so it is not counted as one.
      if (response) record(String(response.status));
      return response;
    } catch (error) {
      // What Bun answers when a route handler throws.
      record("500");
      throw error;
    }
  };

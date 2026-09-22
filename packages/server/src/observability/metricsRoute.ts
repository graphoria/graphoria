import type { CapabilityGrant } from "../authentication/capabilities";

import { S401 } from "../utils/responses";

export type MetricsRouteOptions = {
  path: string;
  /** The header a scoped credential rides in — the admin-secret header. */
  secretHeader: string;
  authorize: (candidate: string | null) => CapabilityGrant | null;
  render: () => string;
};

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * A scrape is gated because the exposition names operations, roles and
 * databases. It is deliberately not rate limited: a scrape interval is fixed
 * and counting it against a caller ceiling would drop samples.
 */
export const createMetricsRoute = ({
  path,
  secretHeader,
  authorize,
  render,
}: MetricsRouteOptions) => ({
  [path]: {
    GET: (req: Request) => {
      if (!authorize(req.headers.get(secretHeader))) return new S401({ error: "Unauthorized" });

      return new Response(render(), { headers: { "content-type": CONTENT_TYPE } });
    },
  },
});

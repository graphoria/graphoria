import { logger } from "../logging";
import { S200, S503 } from "../utils/responses";

export type HealthCheck = {
  kind: string;
  name?: string;
  probe: () => Promise<boolean> | boolean;
};

export type HealthRoutesOptions = {
  basePath: string;
  /** Read on every readiness request, so a check can follow state that changes after boot. */
  checks: () => HealthCheck[];
  timeoutMs: number;
};

const runCheck = async ({ probe }: HealthCheck, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(probe),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Unauthenticated probes for an orchestrator. Liveness touches nothing, so a
 * dependency outage never gets the process restarted; readiness pings every
 * dependency and answers 503 while one is down. The body names each check and
 * whether it passed — the reason stays in the log, because a driver error can
 * carry a host and port.
 */
export const createHealthRoutes = ({ basePath, checks, timeoutMs }: HealthRoutesOptions) => {
  const log = logger("health");

  const live = () => new S200({ status: "ok" });

  const ready = async () => {
    const results = await Promise.all(
      checks().map(async (check) => {
        let ok = false;
        try {
          ok = (await runCheck(check, timeoutMs)) === true;
          if (!ok) log.warn({ kind: check.kind, name: check.name }, "readiness check failed");
        } catch (error) {
          log.warn({ kind: check.kind, name: check.name, err: error }, "readiness check failed");
        }
        return { kind: check.kind, ...(check.name ? { name: check.name } : {}), ok };
      }),
    );

    const healthy = results.every((result) => result.ok);
    const body = { status: healthy ? "ok" : "unavailable", checks: results };

    return healthy ? new S200(body) : new S503(body);
  };

  return {
    [`${basePath}/live`]: live,
    [`${basePath}/ready`]: ready,
  };
};

import { logger } from "./logging";

/**
 * The drain gets `SHUTDOWN_TIMEOUT_MS` (8 s by default) and the teardown this
 * much after it, which keeps the default under Docker's 10 s grace period.
 */
const TEARDOWN_TIMEOUT_MS = 1000;

export type ShutdownServer = {
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly pendingRequests: number;
};

export type ShutdownStep = { name: string; run: () => unknown };

export type ShutdownOptions = {
  /** How long in-flight requests get to finish before the rest are reset. */
  timeoutMs: number;
  /** Run as the listener closes, so that nothing new starts. */
  stopIntake: ShutdownStep[];
  /** Run in order once the drain is over. */
  teardown: ShutdownStep[];
  teardownTimeoutMs?: number;
};

const settlesWithin = async (promise: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Returns `shutdown(server)`: stop intake, drain, tear down. It runs once; every
 * later call gets the first call's promise. Resolves `true` on a clean drain,
 * `false` when the drain timed out or a step failed. Never exits the process.
 */
export const createShutdown = ({
  timeoutMs,
  stopIntake,
  teardown,
  teardownTimeoutMs = TEARDOWN_TIMEOUT_MS,
}: ShutdownOptions) => {
  const log = logger("shutdown");
  let running: Promise<boolean> | undefined;

  const run = async (server: ShutdownServer) => {
    let clean = true;

    const runStep = async (step: ShutdownStep) => {
      try {
        await step.run();
        log.info({ step: step.name }, "shutdown step done");
      } catch (error) {
        clean = false;
        log.error({ err: error, step: step.name }, "shutdown step failed");
      }
    };

    const drain = server.stop();
    for (const step of stopIntake) await runStep(step);

    if (!(await settlesWithin(drain, timeoutMs))) {
      clean = false;
      log.warn(
        { pendingRequests: server.pendingRequests, timeoutMs },
        "drain timed out, resetting the connections left",
      );
      await server.stop(true);
    }

    let pending: string | undefined;
    const steps = (async () => {
      for (const step of teardown) {
        pending = step.name;
        await runStep(step);
      }
    })();

    if (!(await settlesWithin(steps, teardownTimeoutMs))) {
      clean = false;
      log.error({ step: pending, timeoutMs: teardownTimeoutMs }, "teardown timed out");
    }

    log.info({ clean }, "shutdown complete");
    return clean;
  };

  return (server: ShutdownServer): Promise<boolean> => (running ??= run(server));
};

export type SignalTarget = {
  on(event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
};

/**
 * Returns `handleSignals(server)`: the first SIGTERM or SIGINT runs `shutdown`
 * and exits 0 when it was clean, 1 otherwise. A second signal exits 1 at once.
 * Only the first call installs listeners.
 */
export const createSignalHandler = <S>(
  shutdown: (server: S) => Promise<boolean>,
  target: SignalTarget = process,
) => {
  const log = logger("shutdown");
  let installed = false;

  return (server: S) => {
    if (installed) return;
    installed = true;

    let signalled = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (signalled) {
        log.warn({ signal }, "forced shutdown");
        target.exit(1);
        return;
      }
      signalled = true;
      log.info({ signal }, "shutting down");
      void shutdown(server).then((clean) => target.exit(clean ? 0 : 1));
    };

    target.on("SIGTERM", onSignal);
    target.on("SIGINT", onSignal);
  };
};

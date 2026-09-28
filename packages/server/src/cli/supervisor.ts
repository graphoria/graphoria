/** The 5th worker crash within 60 s, across all workers, stops the supervisor. */
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;

const RESTART_INITIAL_DELAY = 1000;
const RESTART_MAX_DELAY = 30_000;
/** A worker up this long starts its slot's backoff over when it next crashes. */
const HEALTHY_UPTIME_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

export type SupervisedWorker = {
  pid: number;
  /** Resolves with the exit code, or 128 + the signal number. */
  exited: Promise<number>;
  readonly signalCode: string | null;
  kill(signal?: NodeJS.Signals): void;
};

export type SupervisorOptions = {
  workers: number;
  spawn: () => SupervisedWorker;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  log?: (message: string) => void;
  exit?: (code: number) => void;
};

type Slot = {
  worker?: SupervisedWorker;
  startedAt: number;
  delay: number;
  restart?: Timer;
};

/**
 * Keeps `workers` server processes running. A worker that exits while no
 * shutdown is under way has crashed, whatever its code: its slot restarts after
 * a backoff, until crashes come too fast and the supervisor gives up. `signal()`
 * stops every worker and exits 0 when all of them stopped cleanly.
 */
export const createSupervisor = ({
  workers,
  spawn,
  now = Date.now,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
  log = console.error,
  exit = process.exit,
}: SupervisorOptions) => {
  const slots: Slot[] = Array.from({ length: workers }, () => ({
    startedAt: 0,
    delay: RESTART_INITIAL_DELAY,
  }));
  const crashes: number[] = [];
  let stopping = false;
  let exitCode = 0;

  const live = () => slots.flatMap((slot) => (slot.worker ? [slot.worker] : []));

  const stop = (code: number) => {
    stopping = true;
    exitCode = code;
    for (const slot of slots) {
      if (slot.restart === undefined) continue;
      clearTimeoutFn(slot.restart);
      slot.restart = undefined;
    }
    for (const worker of live()) worker.kill("SIGTERM");
    if (live().length === 0) exit(exitCode);
  };

  const onExit = (index: number, worker: SupervisedWorker, code: number) => {
    const slot = slots[index]!;
    slot.worker = undefined;

    if (stopping) {
      if (code !== 0 && exitCode === 0) exitCode = 1;
      if (live().length === 0) exit(exitCode);
      return;
    }

    const at = now();
    crashes.push(at);
    while (crashes[0]! <= at - CRASH_WINDOW_MS) crashes.shift();

    const signal = worker.signalCode ? ` (${worker.signalCode})` : "";
    log(`worker ${index} (pid ${worker.pid}) exited with code ${code}${signal}`);

    if (crashes.length >= MAX_CRASHES) {
      log(`${MAX_CRASHES} worker crashes within ${CRASH_WINDOW_MS / 1000} s, stopping`);
      stop(code === 0 ? 1 : code);
      return;
    }

    if (at - slot.startedAt >= HEALTHY_UPTIME_MS) slot.delay = RESTART_INITIAL_DELAY;
    const delay = slot.delay;
    slot.delay = Math.min(delay * 2, RESTART_MAX_DELAY);

    log(`restarting worker ${index} in ${delay} ms`);
    slot.restart = setTimeoutFn(() => {
      slot.restart = undefined;
      startSlot(index);
    }, delay);
  };

  const startSlot = (index: number) => {
    const slot = slots[index]!;
    const worker = spawn();
    slot.worker = worker;
    slot.startedAt = now();
    void worker.exited.then((code) => onExit(index, worker, code));
  };

  return {
    start: () => {
      for (let index = 0; index < workers; index++) startSlot(index);
    },
    /** First call: stop every worker. Later calls: signal the ones still running again. */
    signal: () => {
      if (stopping) {
        for (const worker of live()) worker.kill("SIGTERM");
        return;
      }
      stop(0);
    },
    /** For the parent's own exit: leave no worker behind. */
    kill: () => {
      for (const worker of live()) worker.kill("SIGTERM");
    },
  };
};

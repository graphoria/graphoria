import { describe, expect, it } from "bun:test";

import { createSupervisor } from "./supervisor";

type FakeWorker = {
  pid: number;
  exited: Promise<number>;
  signalCode: string | null;
  signals: string[];
  /** Ends the worker as if it exited on its own. */
  end: (code: number) => Promise<void>;
};

const harness = (workers: number) => {
  let clock = 0;
  let nextPid = 100;
  const spawned: FakeWorker[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const exits: number[] = [];

  const supervisor = createSupervisor({
    workers,
    spawn: () => {
      let finish!: (code: number) => void;
      const worker: FakeWorker = {
        pid: nextPid++,
        exited: new Promise<number>((resolve) => {
          finish = resolve;
        }),
        signalCode: null,
        signals: [],
        end: async (code) => {
          finish(code);
          await Bun.sleep(0);
        },
      };
      spawned.push(worker);
      return {
        pid: worker.pid,
        exited: worker.exited,
        get signalCode() {
          return worker.signalCode;
        },
        kill: (signal = "SIGTERM") => {
          worker.signals.push(signal);
        },
      };
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    },
    log: () => {},
    exit: (code) => {
      exits.push(code);
    },
  });

  const pendingTimers = () => timers.filter((timer) => !timer.cleared);
  const runTimer = () => {
    const timer = pendingTimers().at(-1)!;
    timer.cleared = true;
    timer.fn();
  };
  return {
    supervisor,
    spawned,
    timers,
    exits,
    pendingTimers,
    runTimer,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("createSupervisor", () => {
  it("starts one worker per slot", () => {
    const h = harness(3);

    h.supervisor.start();

    expect(h.spawned).toHaveLength(3);
  });

  it("restarts a crashed worker after 1 s", async () => {
    const h = harness(1);
    h.supervisor.start();

    await h.spawned[0]!.end(1);

    expect(h.pendingTimers().map((timer) => timer.ms)).toEqual([1000]);
    expect(h.spawned).toHaveLength(1);

    h.runTimer();

    expect(h.spawned).toHaveLength(2);
    expect(h.exits).toEqual([]);
  });

  it("treats a worker that exits 0 on its own as a crash", async () => {
    const h = harness(1);
    h.supervisor.start();

    await h.spawned[0]!.end(0);

    expect(h.pendingTimers().map((timer) => timer.ms)).toEqual([1000]);
  });

  it("doubles a slot's backoff up to 30 s", async () => {
    const h = harness(1);
    h.supervisor.start();

    const delays: number[] = [];
    for (let crash = 0; crash < 7; crash++) {
      h.advance(20_000);
      await h.spawned.at(-1)!.end(1);
      delays.push(h.pendingTimers().at(-1)!.ms);
      h.runTimer();
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.exits).toEqual([]);
  });

  it("starts a slot's backoff over once its worker has been up 60 s", async () => {
    const h = harness(1);
    h.supervisor.start();
    for (let crash = 0; crash < 2; crash++) {
      await h.spawned.at(-1)!.end(1);
      h.runTimer();
    }

    h.advance(60_000);
    await h.spawned.at(-1)!.end(1);

    expect(h.pendingTimers().at(-1)!.ms).toBe(1000);
  });

  it("keeps each slot's backoff to itself", async () => {
    const h = harness(2);
    h.supervisor.start();

    await h.spawned[0]!.end(1);
    h.runTimer();
    await h.spawned[2]!.end(1);
    await h.spawned[1]!.end(1);

    expect(h.pendingTimers().map((timer) => timer.ms)).toEqual([2000, 1000]);
  });

  it("gives up at the 5th crash within 60 s: stops the others, exits with the crash's code", async () => {
    const h = harness(2);
    h.supervisor.start();
    const bystander = h.spawned[1]!;

    let crashing = h.spawned[0]!;
    for (let crash = 0; crash < 4; crash++) {
      await crashing.end(3);
      h.runTimer();
      crashing = h.spawned.at(-1)!;
    }
    await crashing.end(3);

    expect(h.pendingTimers()).toEqual([]);
    expect(bystander.signals).toEqual(["SIGTERM"]);
    expect(h.exits).toEqual([]);

    await bystander.end(0);

    expect(h.exits).toEqual([3]);
  });

  it("exits 1 when it gives up on a crash that exited 0", async () => {
    const h = harness(1);
    h.supervisor.start();

    for (let crash = 0; crash < 4; crash++) {
      await h.spawned.at(-1)!.end(0);
      h.runTimer();
    }
    await h.spawned.at(-1)!.end(0);

    expect(h.exits).toEqual([1]);
  });

  it("does not count crashes older than 60 s towards giving up", async () => {
    const h = harness(1);
    h.supervisor.start();

    for (let crash = 0; crash < 4; crash++) {
      await h.spawned.at(-1)!.end(1);
      h.runTimer();
    }
    h.advance(61_000);
    await h.spawned.at(-1)!.end(1);

    expect(h.exits).toEqual([]);
    expect(h.pendingTimers()).toHaveLength(1);
  });

  it("on a signal, sends SIGTERM to every worker, waits for them, and exits 0", async () => {
    const h = harness(2);
    h.supervisor.start();

    h.supervisor.signal();

    expect(h.spawned.map((worker) => worker.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    await h.spawned[0]!.end(0);
    expect(h.exits).toEqual([]);
    await h.spawned[1]!.end(0);

    expect(h.exits).toEqual([0]);
    expect(h.spawned).toHaveLength(2);
  });

  it("exits 1 when a worker does not stop cleanly", async () => {
    const h = harness(2);
    h.supervisor.start();

    h.supervisor.signal();
    await h.spawned[0]!.end(0);
    await h.spawned[1]!.end(1);

    expect(h.exits).toEqual([1]);
  });

  it("cancels a pending restart on a signal", async () => {
    const h = harness(2);
    h.supervisor.start();
    await h.spawned[0]!.end(1);

    h.supervisor.signal();

    expect(h.pendingTimers()).toEqual([]);
    await h.spawned[1]!.end(0);

    expect(h.spawned).toHaveLength(2);
    expect(h.exits).toEqual([0]);
  });

  it("forwards a second signal to the workers still running", async () => {
    const h = harness(2);
    h.supervisor.start();

    h.supervisor.signal();
    await h.spawned[0]!.end(0);
    h.supervisor.signal();

    expect(h.spawned.map((worker) => worker.signals)).toEqual([
      ["SIGTERM"],
      ["SIGTERM", "SIGTERM"],
    ]);
  });

  it("kills every worker still running when the parent exits", async () => {
    const h = harness(2);
    h.supervisor.start();
    await h.spawned[0]!.end(1);

    h.supervisor.kill();

    expect(h.spawned.map((worker) => worker.signals)).toEqual([[], ["SIGTERM"]]);
  });
});

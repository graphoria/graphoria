import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";

import type { ShutdownStep } from "./shutdown";

process.env.LOG_LEVEL ??= "silent";

const { createShutdown, createSignalHandler, exitOnSignalDuringBoot } = await import("./shutdown");

/** A server whose drain finishes only when the test says so, or when forced. */
const fakeServer = () => {
  const stops: boolean[] = [];
  let finishDrain!: () => void;
  const drained = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  const server = {
    pendingRequests: 1,
    stop: (closeActiveConnections = false) => {
      stops.push(closeActiveConnections);
      if (closeActiveConnections) finishDrain();
      return drained;
    },
  };
  return { server, stops, finishDrain };
};

const recorder = () => {
  const events: string[] = [];
  const step = (name: string, run?: () => unknown): ShutdownStep => ({
    name,
    run: () => {
      events.push(name);
      return run?.();
    },
  });
  return { events, step };
};

describe("createShutdown", () => {
  it("stops intake at once and tears down, in order, only once the drain is over", async () => {
    const { events, step } = recorder();
    const { server, stops, finishDrain } = fakeServer();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      stopIntake: [step("websockets"), step("cron")],
      teardown: [step("queues"), step("redis"), step("databases"), step("spans")],
    });

    const result = shutdown(server);
    await Bun.sleep(5);

    expect(stops).toEqual([false]);
    expect(events).toEqual(["websockets", "cron"]);

    finishDrain();

    expect(await result).toBe(true);
    expect(stops).toEqual([false]);
    expect(events).toEqual(["websockets", "cron", "queues", "redis", "databases", "spans"]);
  });

  it("runs once, handing every caller the same result", async () => {
    const { events, step } = recorder();
    const { server, finishDrain } = fakeServer();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      stopIntake: [step("websockets")],
      teardown: [step("databases")],
    });

    const first = shutdown(server);
    const second = shutdown(server);
    finishDrain();

    expect(second).toBe(first);
    expect(await first).toBe(true);
    expect(events).toEqual(["websockets", "databases"]);
  });

  it("resets what is still open once the drain times out, then tears down and reports it", async () => {
    const { events, step } = recorder();
    const { server, stops } = fakeServer();
    const shutdown = createShutdown({
      timeoutMs: 20,
      stopIntake: [],
      teardown: [step("databases")],
    });

    expect(await shutdown(server)).toBe(false);
    expect(stops).toEqual([false, true]);
    expect(events).toEqual(["databases"]);
  });

  it("keeps tearing down after a step fails, and reports it", async () => {
    const { events, step } = recorder();
    const { server, finishDrain } = fakeServer();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      stopIntake: [
        step("websockets", () => {
          throw new Error("boom");
        }),
        step("cron"),
      ],
      teardown: [
        step("queues", async () => {
          throw new Error("broker gone");
        }),
        step("databases"),
      ],
    });

    finishDrain();

    expect(await shutdown(server)).toBe(false);
    expect(events).toEqual(["websockets", "cron", "queues", "databases"]);
  });

  it("gives up on a teardown that outlasts its cap, and reports it", async () => {
    const { server, finishDrain } = fakeServer();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      teardownTimeoutMs: 20,
      stopIntake: [],
      teardown: [{ name: "queues", run: () => new Promise(() => {}) }],
    });

    finishDrain();
    const started = performance.now();

    expect(await shutdown(server)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("createSignalHandler", () => {
  const fakeProcess = () => {
    const target = Object.assign(new EventEmitter(), {
      exits: [] as number[],
      exit: (code: number) => {
        target.exits.push(code);
      },
    });
    return target;
  };

  const controlledShutdown = () => {
    let settle!: (clean: boolean) => void;
    const calls: unknown[] = [];
    const shutdown = (server: unknown) => {
      calls.push(server);
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    };
    return { shutdown, calls, settle: (clean: boolean) => settle(clean) };
  };

  it.each([
    ["SIGTERM", true, 0],
    ["SIGINT", true, 0],
    ["SIGTERM", false, 1],
  ] as const)(
    "on %s shuts the server down, then exits (clean: %p → %p)",
    async (signal, clean, code) => {
      const target = fakeProcess();
      const { shutdown, calls, settle } = controlledShutdown();
      const server = {};
      createSignalHandler(shutdown, target)(server);

      target.emit(signal, signal);
      expect(calls).toEqual([server]);
      expect(target.exits).toEqual([]);

      settle(clean);
      await Bun.sleep(0);

      expect(target.exits).toEqual([code]);
    },
  );

  it("exits 1 at once on a second signal during the drain", () => {
    const target = fakeProcess();
    const { shutdown, calls } = controlledShutdown();
    createSignalHandler(shutdown, target)({});

    target.emit("SIGINT", "SIGINT");
    target.emit("SIGINT", "SIGINT");

    expect(calls).toHaveLength(1);
    expect(target.exits).toEqual([1]);
  });

  it("installs its listeners once however often it is called", () => {
    const target = fakeProcess();
    const handleSignals = createSignalHandler(controlledShutdown().shutdown, target);

    handleSignals({});
    handleSignals({});

    expect(target.listenerCount("SIGTERM")).toBe(1);
    expect(target.listenerCount("SIGINT")).toBe(1);
  });
});

describe("exitOnSignalDuringBoot", () => {
  const fakeProcess = () => {
    const target = Object.assign(new EventEmitter(), {
      exits: [] as number[],
      exit: (code: number) => {
        target.exits.push(code);
      },
    });
    return target;
  };

  it.each(["SIGTERM", "SIGINT"] as const)("exits 0 at once on %s", (signal) => {
    const target = fakeProcess();
    exitOnSignalDuringBoot(target);

    target.emit(signal, signal);

    expect(target.exits).toEqual([0]);
  });

  it("stops listening once released", () => {
    const target = fakeProcess();
    const release = exitOnSignalDuringBoot(target);

    release();
    target.emit("SIGTERM", "SIGTERM");

    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.exits).toEqual([]);
  });
});

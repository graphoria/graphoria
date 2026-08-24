import { afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { GqlQueryFn } from "../types/common";
import type { CronJob } from "../types/configuration";
import type { TickContext } from "../types/zod/cron";
import type { StartCronJobsReturn } from "./index";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

let startCronJobs: (jobs: CronJob[], gqlQuery: GqlQueryFn<true>) => Promise<StartCronJobsReturn>;

beforeAll(async () => {
  ({ startCronJobs } = await import("./index"));
});

const gqlQuery = (async () => ({ data: {} })) as GqlQueryFn<true>;

// croner keeps a process-wide registry of named jobs and rejects a second job
// with a name already taken, so every manager has to be torn down.
let manager: StartCronJobsReturn | undefined;

const start = async (jobs: CronJob[]) => {
  manager = await startCronJobs(jobs, gqlQuery);
  return manager;
};

afterEach(() => {
  manager?.stopAll();
  manager = undefined;
});

const waitFor = async (predicate: () => boolean, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for cron tick");
    await Bun.sleep(25);
  }
};

describe("startCronJobs", () => {
  it("fires ticks with a populated TickContext and stops at maxRuns", async () => {
    const ticks: TickContext[] = [];

    const cron = await start([
      {
        name: "tick_context",
        pattern: "* * * * * *",
        variables: { source: "test" },
        maxRuns: 2,
        catchErrors: true,
        paused: false,
        onTick: (_options, context) => {
          ticks.push(context);
        },
      } as CronJob,
    ]);

    await waitFor(() => ticks.length === 2);

    expect(ticks[0]).toMatchObject({
      name: "tick_context",
      pattern: "* * * * * *",
      variables: { source: "test" },
      executionCount: 1,
    });
    expect(ticks[1]?.executionCount).toBe(2);
    expect(ticks[1]?.previousRun).toBeInstanceOf(Date);
    expect(cron.getSummary()[0]?.executionCount).toBe(2);
  });

  it("passes the configured context object through to the job", async () => {
    let seen: unknown;

    const cron = await start([
      {
        name: "context_passthrough",
        pattern: "* * * * * *",
        maxRuns: 1,
        catchErrors: true,
        paused: false,
        context: { tenant: "acme" },
        onTick: () => {
          seen = cron.getJob("context_passthrough")?.job.options.context;
        },
      } as CronJob,
    ]);

    await waitFor(() => seen !== undefined);

    expect(seen).toEqual({ tenant: "acme" });
  });

  it("reflects pause, resume and stop in the reported status", async () => {
    const cron = await start([
      { name: "controls", pattern: "0 0 * * *", catchErrors: true, paused: false } as CronJob,
    ]);

    expect(cron.getStatus("controls")).toMatchObject({ exists: true, isRunning: true });

    cron.pause("controls");
    expect(cron.getStatus("controls")).toMatchObject({ isRunning: false, isStopped: false });

    cron.resume("controls");
    expect(cron.getStatus("controls")).toMatchObject({ isRunning: true });

    cron.stop("controls");
    expect(cron.getStatus("controls")).toEqual({ exists: false });
  });

  it("skips a job whose pattern croner rejects and still schedules the rest", async () => {
    const cron = await start([
      // Numeric-prefix stepping was accepted by croner 9, rejected by croner 10.
      { name: "legacy_stepping", pattern: "0 0/15 * * *", catchErrors: true } as CronJob,
      { name: "valid_stepping", pattern: "0 */15 * * *", catchErrors: true } as CronJob,
    ]);

    expect(cron.getJob("legacy_stepping")).toBeUndefined();
    expect(cron.getJob("valid_stepping")).toBeDefined();
  });

  it("ignores a duplicate job name instead of throwing", async () => {
    const cron = await start([
      { name: "dupe", pattern: "0 0 * * *", catchErrors: true } as CronJob,
      { name: "dupe", pattern: "0 1 * * *", catchErrors: true } as CronJob,
    ]);

    expect(cron.getAllJobs()).toHaveLength(1);
    expect(cron.getJob("dupe")?.config.pattern).toBe("0 0 * * *");
  });
});

describe("croner 10 pattern semantics", () => {
  it("treats ? as a wildcard rather than the current time value", async () => {
    // croner 9 substituted the value at schedule time, pinning `0 ? * * *` to a
    // single hour per day. croner 10 aliases `?` to `*`, making it hourly.
    const cron = await start([
      { name: "question_mark", pattern: "0 ? * * *", catchErrors: true, paused: true } as CronJob,
    ]);

    const runs = cron.getNextRuns("question_mark", 3);

    expect(runs).toHaveLength(3);
    expect(runs[1]!.getTime() - runs[0]!.getTime()).toBe(60 * 60 * 1000);
    expect(runs[2]!.getTime() - runs[1]!.getTime()).toBe(60 * 60 * 1000);
  });

  it("accepts the 7-part pattern with a year field", async () => {
    const cron = await start([
      {
        name: "with_year",
        pattern: "0 0 0 1 1 * 2099",
        catchErrors: true,
        paused: true,
      } as CronJob,
    ]);

    const nextRun = cron.getNextRun("with_year");

    expect(nextRun?.getFullYear()).toBe(2099);
  });

  it("accepts predefined nicknames", async () => {
    const cron = await start([
      { name: "nickname", pattern: "@midnight", catchErrors: true, paused: true } as CronJob,
    ]);

    const nextRun = cron.getNextRun("nickname");

    expect(nextRun?.getHours()).toBe(0);
    expect(nextRun?.getMinutes()).toBe(0);
  });
});

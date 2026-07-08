import { Cron } from "croner";

import type { GqlQueryFn } from "../types/common";
import type { CronJob } from "../types/configuration";
import type { TickContext } from "../types/zod/cron";

import { databasesConnections, repositoryMap } from "../singletons/databases";
import { queueManager } from "../singletons/queues";
import { logger } from "../logging";

/**
 * Interface for a scheduled cron job instance
 */
export interface ScheduledCronJob {
  name: string;
  job: Cron;
  config: CronJob;
  executionCount: number;
  pause: () => boolean;
  resume: () => boolean;
  trigger: () => boolean;
  stop: () => boolean;
  getNextRun: () => Date | null;
  getNextRuns: (count: number) => Date[];
  getStatus: () => {
    isRunning: boolean;
    isStopped: boolean;
    isBusy: boolean;
    nextRun: Date | null;
    previousRun: Date | null;
    currentRun: Date | null;
  };
}

/**
 * Create a scheduled cron job
 */
const createScheduledJob = (config: CronJob, gqlQuery: GqlQueryFn<true>): ScheduledCronJob => {
  const log = logger("cron").child({ job: config.name });
  let executionCount = 0;

  const job = new Cron(
    config.pattern,
    {
      name: config.name,
      timezone: config.timezone,
      paused: config.paused,
      maxRuns: config.maxRuns,
      interval: config.interval,
      startAt: config.startAt,
      stopAt: config.stopAt,
      protect: config.protect,
      catch: config.catchErrors
        ? (error) => {
            log.error({ err: error }, "cron job caught error");
          }
        : false,
      context: config.context,
    },
    async (self) => {
      try {
        log.info("executing");

        executionCount++;

        // Execute query if provided
        const response = config.query
          ? await gqlQuery(config.query, config.variables ?? {})
          : undefined;

        const tickContext: TickContext = {
          name: config.name,
          pattern: config.pattern,
          variables: config.variables || {},
          executionCount,
          nextRun: self.nextRun(),
          previousRun: self.previousRun(),
        };

        // Call the onTick callback if provided, passing options object
        await config.onTick?.(
          {
            gqlQuery,
            databases: databasesConnections,
            queues: queueManager,
            repository: repositoryMap,
          },
          tickContext,
          response,
        );

        log.info({ executionCount, nextRun: self.nextRun() }, "completed");
      } catch (error) {
        log.error({ err: error }, "failed");
        throw error;
      }
    },
  );

  log.info(
    { pattern: config.pattern, nextRun: job.nextRun(), timezone: config.timezone },
    "scheduled",
  );

  return {
    name: config.name,
    job,
    config,
    executionCount,
    pause: () => {
      job.pause();
      log.info("paused");
      return true;
    },
    resume: () => {
      job.resume();
      log.info({ nextRun: job.nextRun() }, "resumed");
      return true;
    },
    trigger: () => {
      job.trigger();
      log.info("triggered manually");
      return true;
    },
    stop: () => {
      job.stop();
      log.info("stopped");
      return true;
    },
    getNextRun: () => job.nextRun(),
    getNextRuns: (count: number) => job.nextRuns(count),
    getStatus: () => ({
      isRunning: job.isRunning(),
      isStopped: job.isStopped(),
      isBusy: job.isBusy(),
      nextRun: job.nextRun(),
      previousRun: job.previousRun(),
      currentRun: job.currentRun(),
    }),
  };
};

/**
 * Start cron connections and return management functions
 */
export const startCronJobs = async (jobs: CronJob[], gqlQuery: GqlQueryFn<true>) => {
  const log = logger("cron");
  const scheduledJobs = new Map<string, ScheduledCronJob>();

  // Schedule all jobs
  for (const jobConfig of jobs) {
    try {
      if (scheduledJobs.has(jobConfig.name)) {
        log.error({ job: jobConfig.name }, "job name already exists, skipping");
        continue;
      }

      const scheduled = createScheduledJob(jobConfig, gqlQuery);

      scheduledJobs.set(jobConfig.name, scheduled);
    } catch (error) {
      log.error({ err: error, job: jobConfig.name }, "failed to schedule job");
    }
  }

  return {
    jobs: scheduledJobs,

    getJob: (name: string) => scheduledJobs.get(name),

    getAllJobs: () => Array.from(scheduledJobs.values()),

    pause: (name: string) => {
      const job = scheduledJobs.get(name);
      if (!job) return false;
      return job.pause();
    },

    resume: (name: string) => {
      const job = scheduledJobs.get(name);
      if (!job) return false;
      return job.resume();
    },

    trigger: (name: string) => {
      const job = scheduledJobs.get(name);
      if (!job) return false;
      return job.trigger();
    },

    stop: (name: string) => {
      const job = scheduledJobs.get(name);
      if (!job) return false;
      const result = job.stop();
      scheduledJobs.delete(name);
      log.info({ job: name }, "removed");
      return result;
    },

    stopAll: () => {
      for (const [name, job] of scheduledJobs) {
        job.stop();
        log.info({ job: name }, "stopped");
      }
      scheduledJobs.clear();
      log.info("all jobs stopped");
    },

    getNextRun: (name: string) => {
      const job = scheduledJobs.get(name);
      return job ? job.getNextRun() : null;
    },

    getNextRuns: (name: string, count: number) => {
      const job = scheduledJobs.get(name);
      return job ? job.getNextRuns(count) : [];
    },

    getStatus: (name: string) => {
      const job = scheduledJobs.get(name);
      if (!job) {
        return { exists: false };
      }
      return {
        exists: true,
        ...job.getStatus(),
      };
    },

    getSummary: () =>
      Array.from(scheduledJobs.values()).map((job) => ({
        name: job.name,
        pattern: job.config.pattern,
        executionCount: job.executionCount,
        isRunning: job.job.isRunning(),
        isBusy: job.job.isBusy(),
        nextRun: job.job.nextRun(),
      })),

    schedule: (config: CronJob) => {
      if (scheduledJobs.has(config.name)) {
        throw new Error(`Cron job with name "${config.name}" already exists`);
      }
      const scheduled = createScheduledJob(config, gqlQuery);
      scheduledJobs.set(config.name, scheduled);
      return scheduled;
    },
  };
};

export type StartCronJobsReturn = Awaited<ReturnType<typeof startCronJobs>>;

import type { StartCronJobsReturn } from "../cron";
import type { GqlQueryFn } from "../types/common";
import type { CronJob } from "../types/configuration";

import { startCronJobs } from "../cron";

let cronJobs: StartCronJobsReturn | null = null;

export const instantiateCronJobs = async (jobs: CronJob[], gqlQuery: GqlQueryFn<true>) => {
  if (!cronJobs) {
    cronJobs = await startCronJobs(jobs, gqlQuery);
  }

  return cronJobs;
};

export const getCronJobs = () => cronJobs;

export const setCronJobs = (jobs: StartCronJobsReturn | null) => {
  cronJobs = jobs;
};

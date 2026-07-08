import type { DefaultVariables, TypedCronJob } from "../types/cron";

import { createTypedCronJobZod } from "../types/cron";

/**
 * Helper function to create a typed cron job with Zod validation
 * Use this when you want runtime validation of the cron job configuration
 *
 * @example
 * ```typescript
 * const cleanupJob = cron({
 *   name: "cleanup",
 *   pattern: "0 0 * * *",
 *   variables: { maxAge: 30 },
 *   onTick: async (gqlQuery, context) => {
 *     // context.variables is typed as { maxAge: number }
 *     const result = await gqlQuery(`mutation { deleteOld { affected_rows } }`);
 *     console.log(`Deleted ${result.data.affected_rows} rows`);
 *   },
 * });
 * ```
 */
export const cron = <TVariables extends DefaultVariables>(
  config: TypedCronJob<TVariables>,
): TypedCronJob<TVariables> => {
  const schema = createTypedCronJobZod<TVariables>();

  return schema.parse(config) as TypedCronJob<TVariables>;
};

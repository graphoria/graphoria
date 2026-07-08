import { z } from "zod";

/**
 * Default variables type
 */
export const DefaultVariablesSchema = z.record(z.string(), z.unknown());

export type DefaultVariables = z.infer<typeof DefaultVariablesSchema>;

/**
 * Context passed to the tick callback
 */
export type TickContext<TVariables = DefaultVariables> = {
  name: string;
  pattern: string;
  variables: TVariables;
  executionCount: number;
  nextRun: Date | null;
  previousRun: Date | null;
};

/**
 * Cron job tick callback
 */
export type CronTickCallback<TVariables = Record<string, unknown>> = (
  options: {
    gqlQuery: <TReturn = unknown>(
      query: string,
      params?: Record<string, unknown>,
      req?: unknown,
    ) => Promise<{ data: TReturn; errors?: unknown[] }>;
    databases: unknown;
    queues: unknown;
    repository: Record<string, unknown>;
  },
  context: TickContext<TVariables>,
  response?: { data: unknown; errors?: unknown[] },
) => Promise<void> | void;

/**
 * Generic Zod schema factory for typed cron jobs
 * This allows TypeScript to infer the variables type
 */
export const createTypedCronJobZod = <TVariables extends DefaultVariables>() =>
  z.object({
    /**
     * Unique name/identifier for the cron job
     */
    name: z.string().min(1, "Cron job name is required"),

    /**
     * Cron pattern or ISO 8601 date string
     * Examples:
     * - "0 0 * * *" (daily at midnight)
     * - "*\/5 * * * *" (every 5 minutes)
     * - "2024-01-23T00:00:00" (specific date/time)
     */
    pattern: z.string().min(1, "Cron pattern is required"),

    /**
     * Optional GraphQL query to execute when the cron job runs
     * If not provided, you must use the gqlQuery function in onTick callback
     */
    query: z.string().optional(),

    /**
     * Optional variables to pass to the GraphQL query
     */
    variables: z.custom<TVariables>().optional(),

    /**
     * Optional timezone (e.g., "America/New_York", "Europe/Stockholm")
     */
    timezone: z.string().optional(),

    /**
     * Whether the job should be paused from start
     */
    paused: z.boolean().optional().default(false),

    /**
     * Maximum number of times the job should run
     */
    maxRuns: z.number().int().positive().optional(),

    /**
     * Minimum number of seconds between triggers
     */
    interval: z.number().int().nonnegative().optional(),

    /**
     * ISO 8601 formatted datetime to start the job
     */
    startAt: z.string().optional(),

    /**
     * ISO 8601 formatted datetime to stop the job
     */
    stopAt: z.string().optional(),

    /**
     * Enable over-run protection (blocks new triggers while old one is in progress)
     */
    protect: z.boolean().optional(),

    /**
     * Whether to catch errors silently or handle them
     */
    catchErrors: z.boolean().optional().default(true),

    /**
     * Context to pass along with the cron job (for logging, etc.)
     */
    context: z.record(z.string(), z.any()).optional(),

    /**
     * Callback executed on each tick
     */
    onTick: z.custom<CronTickCallback<TVariables>>().optional(),
  });

export const TypedCronJobZod = createTypedCronJobZod();

export type CronJobType = z.input<typeof TypedCronJobZod>;

/**
 * Typed cron job definition
 */
export type TypedCronJob<TVariables = DefaultVariables> = Omit<
  CronJobType,
  "variables" | "onTick"
> & {
  variables?: TVariables;
  onTick?: CronTickCallback<TVariables>;
};

/**
 * Cron job configuration (alias of TypedCronJob, kept for the public config surface)
 */
export type CronJobConfig<TVariables = DefaultVariables> = TypedCronJob<TVariables>;

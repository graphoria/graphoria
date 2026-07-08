import { TypedCronJobZod as BaseTypedCronJobZod } from "../../config";
import { z } from "zod";

import type { DefaultVariables, TickContext } from "../../config";
import type { BackgroundCallbackOptions } from "../common";

// Re-export definition types from config package
export {
  DefaultVariablesSchema,
  createTypedCronJobZod,
  type DefaultVariables,
  type TickContext,
  type TypedCronJob,
  type CronJobType,
} from "../../config";

/**
 * Tick callback function type - receives options object with gqlQuery and databases
 * This is server-specific because it references runtime types (BackgroundCallbackOptions)
 */
export type TickCallback<TVariables = DefaultVariables> = (
  options: BackgroundCallbackOptions,
  context: TickContext<TVariables>,
  response?: { data: unknown; errors?: unknown[] },
) => Promise<void> | void;

/**
 * Server-specific Zod schema that extends the config schema with onTick callback
 */
export const TypedCronJobZod = BaseTypedCronJobZod.extend({
  /**
   * Optional callback function executed on each tick
   */
  onTick: z.custom<TickCallback>().optional(),
});

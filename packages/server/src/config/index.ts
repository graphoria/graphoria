/**
 * Configuration-authoring surface for `graphoria.ts` files.
 *
 * Exposed as `@graphoria/server/config`: the full configuration API
 * (helpers + types) plus the server-only runtime maps, so consumers can
 * install `@graphoria/server` alone and import everything a config file
 * needs from `@graphoria/server/config`.
 *
 * @example
 * ```ts
 * import { operation, queue, z } from "@graphoria/server/config";
 * import type { ConfigurationFn } from "@graphoria/server/config";
 *
 * const ping = operation({
 *   input: z.object({}),
 *   output: z.string(),
 *   handler: async () => "pong",
 * });
 * ```
 */
import { z } from "zod";

import type {
  ConfigurationInput,
  CreateOneToBooleanMSSQLFn,
  CreateYAndNToBooleanMSSQLFn,
  VirtualColumnExpressionFn,
  VirtualColumnFunctionFn,
} from "./types";
import type { operation } from "./helpers";

// ============================================================================
// Operation Helper Function Type
// ============================================================================

/** Type of the `operation` helper a configuration function receives: the same `operation()` exported below. */
export type OperationFn = typeof operation;

// ============================================================================
// Configuration Helpers Type
// ============================================================================

/**
 * Configuration helpers object passed to the configuration function
 */
export type ConfigurationHelpers = {
  /** Zod validation library instance */
  z: typeof z;
  /** Helper function to define operations */
  operation: OperationFn;
  /** Helper to create virtual columns from MSSQL 1/0 to boolean */
  createOneToBooleanMSSQL: CreateOneToBooleanMSSQLFn;
  /** Helper to create virtual columns from MSSQL Y/N to boolean */
  createYAndNToBooleanMSSQL: CreateYAndNToBooleanMSSQLFn;
  /** Helper to create virtual columns from SQL expressions */
  virtualColumnExpression: VirtualColumnExpressionFn;
  /** Helper to create virtual columns from SQL functions */
  virtualColumnFunction: VirtualColumnFunctionFn;
};

/**
 * Configuration function type that receives helpers and returns configuration
 *
 * @example
 * ```ts
 * import type { ConfigurationFn } from "@graphoria/server/config";
 *
 * export default (({ z, operation, virtualColumnFunction }) => ({
 *   name: "My API",
 *   version: "1.0.0",
 *   databases: [...],
 *   operations: {
 *     getUsers: operation({
 *       query: `query { users { id name } }`,
 *       rest: { path: "/users" },
 *     }),
 *   },
 * })) satisfies ConfigurationFn;
 * ```
 */
export type ConfigurationFn = (helpers: ConfigurationHelpers) => ConfigurationInput;

// Re-export all types
export * from "./types";

// Re-export helpers
export {
  operation,
  cron,
  queue,
  type InferOperationInput,
  type InferOperationOutput,
  type InferOperationInitData,
} from "./helpers";

// Re-export cron definition types
export {
  DefaultVariablesSchema,
  createTypedCronJobZod,
  TypedCronJobZod,
  type DefaultVariables,
  type TickContext,
  type TypedCronJob,
  type CronJobType,
} from "./types/cron";

// Re-export zod for convenience
export { z } from "zod";

export const createApiResponse = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    status: z.string(),
    data: dataSchema.optional(),
  });

/** Runtime maps populated during boot: live connection pools and repositories. */
export type { RepositoryMap, DatabasesConnections } from "../singletons/databases";

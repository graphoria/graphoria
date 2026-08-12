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
// oxlint-disable typescript/no-explicit-any
import { z } from "zod";

import type {
  ConfigurationInput,
  CreateOneToBooleanMSSQLFn,
  CreateYAndNToBooleanMSSQLFn,
  DefaultInput,
  OperationCacheConfig,
  OperationGraphQLConfig,
  OperationHandler,
  OperationOptions,
  OperationRestConfig,
  TypedOperation,
  VirtualColumnExpressionFn,
  VirtualColumnFunctionFn,
} from "./types";

// ============================================================================
// Operation Helper Function Type
// ============================================================================

/**
 * Helper type to infer the output type from a Zod schema
 * Uses z.output to get the transformed/parsed output type
 */
type InferZodOutput<T> = T extends z.ZodType<infer O, any, any> ? O : never;

/**
 * Infer TOutput from TOutputSchema
 */
type InferOutput<TOutputSchema> =
  TOutputSchema extends z.ZodType<any> ? InferZodOutput<TOutputSchema> : unknown;

/**
 * Type for the operation helper function provided by @graphoria/server.
 *
 * This uses a simplified approach where we accept any ZodObject for input/output
 * and return TypedOperation with appropriate type inference.
 */
export type OperationFn = {
  // Query operation overload - with input schema
  <
    TInputSchema extends z.ZodObject<any>,
    TOutputSchema extends z.ZodType<any> | undefined = undefined,
    TInitData = unknown,
  >(config: {
    /** GraphQL query to execute */
    query: string;
    /** Custom handler is not allowed with query */
    handler?: never;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input: TInputSchema;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: {
      init?: (options: OperationOptions) => TInitData | Promise<TInitData>;
      beforeRequest?: (
        context: { input: z.infer<TInputSchema> },
        initData: TInitData | undefined,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
      afterRequest?: (context: {
        output: InferOutput<TOutputSchema>;
      }) => InferOutput<TOutputSchema> | Promise<InferOutput<TOutputSchema>>;
    };
    /** REST exposure configuration */
    rest?: OperationRestConfig;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }): TypedOperation<z.infer<TInputSchema>, InferOutput<TOutputSchema>, TInitData, unknown>;

  // Query operation overload - without input schema
  <TOutputSchema extends z.ZodType<any> | undefined = undefined, TInitData = unknown>(config: {
    /** GraphQL query to execute */
    query: string;
    /** Custom handler is not allowed with query */
    handler?: never;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input?: undefined;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: {
      init?: (options: OperationOptions) => TInitData | Promise<TInitData>;
      beforeRequest?: (
        context: { input: DefaultInput },
        initData: TInitData | undefined,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
      afterRequest?: (context: {
        output: InferOutput<TOutputSchema>;
      }) => InferOutput<TOutputSchema> | Promise<InferOutput<TOutputSchema>>;
    };
    /** REST exposure configuration */
    rest?: OperationRestConfig;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }): TypedOperation<DefaultInput, InferOutput<TOutputSchema>, TInitData, unknown>;

  // Handler operation overload - with input schema
  <
    TInputSchema extends z.ZodObject<any>,
    TOutputSchema extends z.ZodType<any> | undefined = undefined,
    TInitData = unknown,
  >(config: {
    /** Query is not allowed with handler */
    query?: never;
    /** Custom handler function */
    handler: OperationHandler<z.infer<TInputSchema>, InferOutput<TOutputSchema>, unknown>;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input: TInputSchema;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: {
      init?: (options: OperationOptions) => TInitData | Promise<TInitData>;
      beforeRequest?: (
        context: { input: z.infer<TInputSchema> },
        initData: TInitData | undefined,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
      afterRequest?: (context: {
        output: InferOutput<TOutputSchema>;
      }) => InferOutput<TOutputSchema> | Promise<InferOutput<TOutputSchema>>;
    };
    /** REST exposure configuration */
    rest?: OperationRestConfig;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }): TypedOperation<z.infer<TInputSchema>, InferOutput<TOutputSchema>, TInitData, unknown>;

  // Handler operation overload - without input schema
  <TOutputSchema extends z.ZodType<any> | undefined = undefined, TInitData = unknown>(config: {
    /** Query is not allowed with handler */
    query?: never;
    /** Custom handler function */
    handler: OperationHandler<DefaultInput, InferOutput<TOutputSchema>, unknown>;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input?: undefined;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: {
      init?: (options: OperationOptions) => TInitData | Promise<TInitData>;
      beforeRequest?: (
        context: { input: DefaultInput },
        initData: TInitData | undefined,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
      afterRequest?: (context: {
        output: InferOutput<TOutputSchema>;
      }) => InferOutput<TOutputSchema> | Promise<InferOutput<TOutputSchema>>;
    };
    /** REST exposure configuration */
    rest?: OperationRestConfig;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }): TypedOperation<DefaultInput, InferOutput<TOutputSchema>, TInitData, unknown>;

  /**
   * Creates a typed operation helper with custom repository type.
   * Use this when you need typed access to repository in the handler.
   *
   * The generic is the databases map, keyed by database name; the handler's
   * `options.repository` is that map, so access a repository as
   * `repository[dbName]` (e.g. `repository.main`).
   */
  typed: <TRepository>() => <
    TInputSchema extends z.ZodObject<any>,
    TOutputSchema extends z.ZodType<any> | undefined = undefined,
    TInitData = unknown,
  >(config: {
    /** Query is not allowed with handler */
    query?: never;
    /** Custom handler function */
    handler: OperationHandler<z.infer<TInputSchema>, InferOutput<TOutputSchema>, TRepository>;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input: TInputSchema;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: {
      init?: (options: OperationOptions) => TInitData | Promise<TInitData>;
      beforeRequest?: (
        context: { input: z.infer<TInputSchema> },
        initData: TInitData | undefined,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
      afterRequest?: (context: {
        output: InferOutput<TOutputSchema>;
      }) => InferOutput<TOutputSchema> | Promise<InferOutput<TOutputSchema>>;
    };
    /** REST exposure configuration */
    rest?: OperationRestConfig;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }) => TypedOperation<z.infer<TInputSchema>, InferOutput<TOutputSchema>, TInitData, TRepository>;
};

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

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
  AnyQueryDocument,
  ConfigurationInput,
  CreateOneToBooleanMSSQLFn,
  CreateYAndNToBooleanMSSQLFn,
  DefaultInput,
  OperationCacheConfig,
  OperationGraphQLConfig,
  OperationHandler,
  OperationOptions,
  QueryResultOf,
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
 * Infer the parsed shape of an optional REST parameter schema.
 * Resolves to `undefined` when that source has no schema configured.
 */
type InferRestParam<T> = T extends z.ZodType<any> ? z.infer<T> : undefined;

/**
 * REST exposure config with per-source schema generics, so `pathParams`,
 * `queryParams`, and `body` can be inferred into the `beforeRequest` context.
 */
type RestConfigInput<
  TPathParams extends z.ZodType<any> | undefined,
  TQueryParams extends z.ZodType<any> | undefined,
  TBody extends z.ZodType<any> | undefined,
> = {
  /** Route path (e.g. `/users/:id`) */
  path: string;
  /** HTTP method (defaults to GET) */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Zod schema for path parameters */
  pathParams?: TPathParams;
  /** Zod schema for query-string parameters */
  queryParams?: TQueryParams;
  /** Zod schema for the request body */
  body?: TBody;
};

/**
 * Hooks config shared by every operation overload. `beforeRequest` receives the
 * merged `input` plus each REST source (`pathParams` / `queryParams` / `body`)
 * typed from its schema, or `undefined` when that source's schema is omitted.
 */
type OperationHooks<
  TInput,
  TOutput,
  TInitData,
  TPathParams extends z.ZodType<any> | undefined,
  TQueryParams extends z.ZodType<any> | undefined,
  TBody extends z.ZodType<any> | undefined,
  TAfterInput = TOutput,
> = {
  init?: (options: OperationOptions) => TInitData | Promise<TInitData>;
  beforeRequest?: (
    context: {
      input: TInput;
      pathParams: InferRestParam<TPathParams>;
      queryParams: InferRestParam<TQueryParams>;
      body: InferRestParam<TBody>;
    },
    initData: TInitData | undefined,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Transforms the result after a successful query/handler. `output` is the
   * upstream value: for query operations the query result (typed from a gql.tada
   * `query` document, otherwise `unknown`); for handler operations the handler's
   * return. The value you return becomes the response payload, typed by the
   * operation's `output` schema.
   */
  afterRequest?: (context: { output: TAfterInput }) => TOutput | Promise<TOutput>;
};

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
    TPathParams extends z.ZodType<any> | undefined = undefined,
    TQueryParams extends z.ZodType<any> | undefined = undefined,
    TBody extends z.ZodType<any> | undefined = undefined,
    TQuery extends string | AnyQueryDocument = string,
  >(config: {
    /** GraphQL query to execute (a string or a gql.tada `graphql()` document) */
    query: TQuery;
    /** Custom handler is not allowed with query */
    handler?: never;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input: TInputSchema;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: OperationHooks<
      z.infer<TInputSchema>,
      InferOutput<TOutputSchema>,
      TInitData,
      TPathParams,
      TQueryParams,
      TBody,
      QueryResultOf<TQuery>
    >;
    /** REST exposure configuration */
    rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }): TypedOperation<z.infer<TInputSchema>, InferOutput<TOutputSchema>, TInitData, unknown>;

  // Query operation overload - without input schema
  <
    TOutputSchema extends z.ZodType<any> | undefined = undefined,
    TInitData = unknown,
    TPathParams extends z.ZodType<any> | undefined = undefined,
    TQueryParams extends z.ZodType<any> | undefined = undefined,
    TBody extends z.ZodType<any> | undefined = undefined,
    TQuery extends string | AnyQueryDocument = string,
  >(config: {
    /** GraphQL query to execute (a string or a gql.tada `graphql()` document) */
    query: TQuery;
    /** Custom handler is not allowed with query */
    handler?: never;
    /** Description for documentation */
    description?: string;
    /** Input schema (Zod) */
    input?: undefined;
    /** Output schema (Zod) */
    output?: TOutputSchema;
    /** Hooks for initialization and request transformation */
    hooks?: OperationHooks<
      DefaultInput,
      InferOutput<TOutputSchema>,
      TInitData,
      TPathParams,
      TQueryParams,
      TBody,
      QueryResultOf<TQuery>
    >;
    /** REST exposure configuration */
    rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
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
    TPathParams extends z.ZodType<any> | undefined = undefined,
    TQueryParams extends z.ZodType<any> | undefined = undefined,
    TBody extends z.ZodType<any> | undefined = undefined,
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
    hooks?: OperationHooks<
      z.infer<TInputSchema>,
      InferOutput<TOutputSchema>,
      TInitData,
      TPathParams,
      TQueryParams,
      TBody
    >;
    /** REST exposure configuration */
    rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
    /** GraphQL exposure configuration (enabled by default) */
    graphql?: OperationGraphQLConfig;
    /** Cache configuration */
    cache?: OperationCacheConfig;
  }): TypedOperation<z.infer<TInputSchema>, InferOutput<TOutputSchema>, TInitData, unknown>;

  // Handler operation overload - without input schema
  <
    TOutputSchema extends z.ZodType<any> | undefined = undefined,
    TInitData = unknown,
    TPathParams extends z.ZodType<any> | undefined = undefined,
    TQueryParams extends z.ZodType<any> | undefined = undefined,
    TBody extends z.ZodType<any> | undefined = undefined,
  >(config: {
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
    hooks?: OperationHooks<
      DefaultInput,
      InferOutput<TOutputSchema>,
      TInitData,
      TPathParams,
      TQueryParams,
      TBody
    >;
    /** REST exposure configuration */
    rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
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
    TPathParams extends z.ZodType<any> | undefined = undefined,
    TQueryParams extends z.ZodType<any> | undefined = undefined,
    TBody extends z.ZodType<any> | undefined = undefined,
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
    hooks?: OperationHooks<
      z.infer<TInputSchema>,
      InferOutput<TOutputSchema>,
      TInitData,
      TPathParams,
      TQueryParams,
      TBody
    >;
    /** REST exposure configuration */
    rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
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

import { z } from "zod";

/**
 * Default input type when no schema is provided
 */
export type DefaultInput = Record<string, unknown>;

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/**
 * Zod schema for REST configuration
 */
export const OperationRestConfigZod = z.object({
  path: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  pathParams: z.custom<z.ZodType>().optional(),
  queryParams: z.custom<z.ZodType>().optional(),
  body: z.custom<z.ZodType>().optional(),
});

/**
 * Zod schema for GraphQL configuration
 */
export const OperationGraphQLConfigZod = z.object({
  enabled: z.boolean().optional().default(true),
  name: z.string().optional(),
});

/**
 * Zod schema for cache configuration
 */
export const OperationCacheConfigZod = z.object({
  max: z.number().int().positive().optional(),
  maxSize: z.number().int().positive().optional(),
  ttl: z.number().int().positive().optional(),
  allowStale: z.boolean().optional(),
  updateAgeOnGet: z.boolean().optional(),
  updateAgeOnHas: z.boolean().optional().default(false),
  ttlAutopurge: z.boolean().optional().default(true),
});

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * REST exposure configuration for an operation
 */
export type OperationRestConfig = z.input<typeof OperationRestConfigZod>;

/**
 * GraphQL exposure configuration for an operation
 */
export type OperationGraphQLConfig = z.input<typeof OperationGraphQLConfigZod>;

/**
 * Cache configuration for an operation
 */
export type OperationCacheConfig = z.input<typeof OperationCacheConfigZod>;

// ============================================================================
// Runtime Operation Validation Schema
// ============================================================================

export const OperationZod = z
  .object({
    description: z.string().optional(),
    query: z.string().optional(),
    // oxlint-disable-next-line typescript/no-explicit-any
    handler: z.custom<OperationHandler<any, any, any>>().optional(),
    // oxlint-disable-next-line typescript/no-explicit-any
    input: z.custom<z.ZodType<any>>().optional(),
    // oxlint-disable-next-line typescript/no-explicit-any
    output: z.custom<z.ZodType<any>>().optional(),
    hooks: z
      .object({
        // oxlint-disable-next-line typescript/no-explicit-any
        init: z.custom<OperationInitHook<any>>().optional(),
        beforeRequest: z
          // oxlint-disable-next-line typescript/no-explicit-any
          .custom<OperationBeforeRequestHook<any, any, any>>()
          .optional(),
        // oxlint-disable-next-line typescript/no-explicit-any
        afterRequest: z.custom<OperationAfterRequestHook<any>>().optional(),
      })
      .optional(),
    rest: OperationRestConfigZod.optional(),
    graphql: OperationGraphQLConfigZod.optional().default({ enabled: true }),
    cache: OperationCacheConfigZod.optional(),
  })
  .refine(
    (operation) => {
      const hasQuery = operation.query !== undefined;
      const hasHandler = operation.handler !== undefined;
      return (hasQuery || hasHandler) && !(hasQuery && hasHandler);
    },
    {
      message: "Operation must have either 'query' or 'handler', but not both",
    },
  );

export type Operation = z.input<typeof OperationZod>;

export const OperationsZod = z.record(z.string(), OperationZod);

export type Operations = z.input<typeof OperationsZod>;

/**
 * Context passed to beforeRequest hook
 */
export type BeforeRequestContext<TInput = DefaultInput> = {
  input: TInput;
};

/**
 * Context passed to afterRequest hook
 */
export type AfterRequestContext<TOutput = unknown> = {
  output: TOutput;
};

/**
 * Result type for GraphQL queries
 */
export type GqlQueryResult<TReturn = unknown> = {
  data: TReturn;
  errors?: unknown[];
};

/**
 * Base options passed to operation handlers and hooks.
 * This is a simplified type for configuration purposes.
 * At runtime, @graphoria/server provides a fully-typed version with BunRequest support.
 */
export type OperationOptions<TRepository = unknown> = {
  // oxlint-disable-next-line typescript/no-explicit-any
  gqlQuery: <TReturn = unknown>(
    query: string,
    params?: Record<string, unknown>,
    // oxlint-disable-next-line typescript/no-explicit-any
    req?: any,
  ) => Promise<GqlQueryResult<TReturn>>;
  // oxlint-disable-next-line typescript/no-explicit-any
  databases: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  queues: any;
  /**
   * Custom repositories keyed by database name (`repository[dbName]`).
   * `TRepository` is that whole map — e.g. `{ main: MainRepo }`.
   */
  repository: TRepository;
};

/**
 * Init hook - runs once at startup, can return cached data
 */
export type OperationInitHook<TInitData = unknown> = (
  options: OperationOptions,
) => TInitData | Promise<TInitData>;

/**
 * BeforeRequest hook - transforms input before execution
 */
export type OperationBeforeRequestHook<
  TInput = DefaultInput,
  TInitData = unknown,
  TVariables = Record<string, unknown>,
> = (
  context: BeforeRequestContext<TInput>,
  initData: TInitData | undefined,
) => TVariables | Promise<TVariables>;

/**
 * AfterRequest hook - transforms output after execution
 */
export type OperationAfterRequestHook<TOutput = unknown> = (
  context: AfterRequestContext<TOutput>,
) => TOutput | Promise<TOutput>;

/**
 * Custom handler function for operations with custom logic
 */
export type OperationHandler<TInput = DefaultInput, TOutput = unknown, TRepository = unknown> = (
  options: OperationOptions<TRepository>,
  input: TInput,
) => TOutput | Promise<TOutput>;

/**
 * Base operation properties shared by all operation types
 */
export type BaseOperation<TInput, TOutput, TInitData> = {
  /** Description for documentation */
  description?: string;
  /** Input schema (Zod) - defines what the operation accepts */
  input?: z.ZodType<TInput>;
  /** Output schema (Zod) - defines what the operation returns (for OpenAPI) */
  output?: z.ZodType<TOutput>;
  /** Hooks for initialization and request transformation */
  hooks?: {
    init?: OperationInitHook<TInitData>;
    beforeRequest?: OperationBeforeRequestHook<TInput, TInitData>;
    afterRequest?: OperationAfterRequestHook<TOutput>;
  };
  /** REST exposure configuration */
  rest?: OperationRestConfig;
  /** GraphQL exposure configuration (enabled by default) */
  graphql?: OperationGraphQLConfig;
  /** Cache configuration */
  cache?: OperationCacheConfig;
};

/**
 * Query-based operation - executes a GraphQL query
 */
export type QueryOperation<
  TInput = DefaultInput,
  TOutput = unknown,
  TInitData = unknown,
> = BaseOperation<TInput, TOutput, TInitData> & {
  /** GraphQL query to execute */
  query: string;
  /** Custom handler is not allowed with query */
  handler?: never;
};

/**
 * Handler-based operation - executes custom logic
 */
export type HandlerOperation<
  TInput = DefaultInput,
  TOutput = unknown,
  TInitData = unknown,
  TRepository = unknown,
> = BaseOperation<TInput, TOutput, TInitData> & {
  /** Query is not allowed with handler */
  query?: never;
  /** Custom handler function */
  handler: OperationHandler<TInput, TOutput, TRepository>;
};

/**
 * Union type for typed operations - must have either query OR handler
 */
export type TypedOperation<
  TInput = DefaultInput,
  TOutput = unknown,
  TInitData = unknown,
  TRepository = unknown,
> =
  | QueryOperation<TInput, TOutput, TInitData>
  | HandlerOperation<TInput, TOutput, TInitData, TRepository>;

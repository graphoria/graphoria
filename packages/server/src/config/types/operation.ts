import { z } from "zod";

/**
 * Default input type when no schema is provided
 */
export type DefaultInput = Record<string, unknown>;

/**
 * A gql.tada / `TypedDocumentNode` query document. Every GraphQL AST node has a
 * `kind`, which distinguishes a document from a plain string query; documents
 * additionally carry their result type on the `__apiType` phantom property.
 */
export type AnyQueryDocument = { readonly kind: string };

/**
 * Extracts a query document's result type (the GraphQL `data` payload) from its
 * gql.tada / TypedDocumentNode `__apiType` phantom. A plain string query (or a
 * document without embedded types) resolves to `unknown`.
 */
export type QueryResultOf<TQuery> = TQuery extends string
  ? unknown
  : // oxlint-disable-next-line typescript/no-explicit-any
    TQuery extends { __apiType?: (variables: any) => infer TResult }
    ? TResult
    : unknown;

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/**
 * Zod schema for REST configuration
 */
export const OperationRestConfigZod = z.strictObject({
  path: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  pathParams: z.custom<z.ZodType>().optional(),
  queryParams: z.custom<z.ZodType>().optional(),
  body: z.custom<z.ZodType>().optional(),
});

/**
 * Zod schema for GraphQL configuration
 */
export const OperationGraphQLConfigZod = z.strictObject({
  enabled: z.boolean().optional().default(true),
  name: z.string().optional(),
});

/**
 * Zod schema for cache configuration
 */
export const OperationCacheConfigZod = z.strictObject({
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
  .strictObject({
    description: z.string().optional(),
    query: z.string().optional(),
    // oxlint-disable-next-line typescript/no-explicit-any
    handler: z.custom<OperationHandler<any, any, any>>().optional(),
    // oxlint-disable-next-line typescript/no-explicit-any
    input: z.custom<z.ZodType<any>>().optional(),
    // oxlint-disable-next-line typescript/no-explicit-any
    output: z.custom<z.ZodType<any>>().optional(),
    hooks: z
      .strictObject({
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
    /** Statement timeout in milliseconds. Overrides QUERY_TIMEOUT_MS for this operation. */
    timeout: z.number().int().positive().optional(),
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
 * Context passed to beforeRequest hook.
 *
 * `input` is the merged view of every REST parameter source. `pathParams`,
 * `queryParams`, and `body` expose each source separately (parsed with its own
 * schema), or `undefined` when that source has no schema configured.
 */
export type BeforeRequestContext<
  TInput = DefaultInput,
  TPathParams = unknown,
  TQueryParams = unknown,
  TBody = unknown,
> = {
  input: TInput;
  pathParams?: TPathParams;
  queryParams?: TQueryParams;
  body?: TBody;
};

/**
 * Context passed to the afterRequest hook.
 *
 * `output` is the operation's output payload — for query-based operations the
 * unwrapped GraphQL `data` (the hook's return replaces `data` in the response
 * envelope); for handler-based operations the value the handler returned.
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
 * AfterRequest hook — transforms the output after a successful query/handler.
 *
 * Receives the output payload and returns the (possibly transformed) payload.
 * Runs on success only; throw to turn a successful response into an error. For
 * cached query operations it runs on the cache miss and the transformed result
 * is cached, so cache hits reuse it without re-invoking the hook.
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
  /** Statement timeout in milliseconds. Overrides `QUERY_TIMEOUT_MS` for this operation. */
  timeout?: number;
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

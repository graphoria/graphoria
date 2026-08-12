import { z } from "zod";

import type {
  DefaultInput,
  HandlerOperation,
  OperationHandler,
  OperationOptions,
  QueryOperation,
  TypedOperation,
} from "../types/operation";

// ============================================================================
// Type-safe operation helper with overloads
// ============================================================================

/**
 * Helper type to infer input type from Zod schema
 */
type InferInput<TInputSchema> = TInputSchema extends z.ZodType<infer T> ? T : DefaultInput;

/**
 * Helper type to infer output type from Zod schema
 */
type InferOutput<TOutputSchema> = TOutputSchema extends z.ZodType<infer T> ? T : unknown;

/**
 * Infer the parsed shape of an optional REST parameter schema.
 * Resolves to `undefined` when that source has no schema configured.
 *
 * Mirrors the helpers on the `OperationFn` authoring surface so both
 * `operation()` entry points expose identical `beforeRequest` context types.
 */
type InferRestParam<T> = T extends z.ZodType<infer O> ? O : undefined;

/**
 * REST exposure config with per-source schema generics, so `pathParams`,
 * `queryParams`, and `body` can be inferred into the `beforeRequest` context.
 */
type RestConfigInput<
  TPathParams extends z.ZodType | undefined,
  TQueryParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
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
 * Hooks config where `beforeRequest` receives the merged `input` plus each REST
 * source (`pathParams` / `queryParams` / `body`) typed from its schema, or
 * `undefined` when that source's schema is omitted.
 */
type OperationHooksConfig<
  TInput,
  TOutput,
  TInitData,
  TPathParams extends z.ZodType | undefined,
  TQueryParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
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
  afterRequest?: (context: { output: TOutput }) => TOutput | Promise<TOutput>;
};

/**
 * Config type for handler-based operations with inference
 */
type HandlerOperationConfig<
  TRepository,
  TInputSchema extends z.ZodType | undefined,
  TOutputSchema extends z.ZodType | undefined,
  TInitData,
  TPathParams extends z.ZodType | undefined,
  TQueryParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
> = Omit<
  HandlerOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData, TRepository>,
  "handler" | "input" | "output" | "hooks" | "rest"
> & {
  input?: TInputSchema;
  output?: TOutputSchema;
  handler: OperationHandler<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TRepository>;
  hooks?: OperationHooksConfig<
    InferInput<TInputSchema>,
    InferOutput<TOutputSchema>,
    TInitData,
    TPathParams,
    TQueryParams,
    TBody
  >;
  rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
};

/**
 * Config type for query-based operations with inference
 */
type QueryOperationConfig<
  TInputSchema extends z.ZodType | undefined,
  TOutputSchema extends z.ZodType | undefined,
  TInitData,
  TPathParams extends z.ZodType | undefined,
  TQueryParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
> = Omit<
  QueryOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData>,
  "input" | "output" | "hooks" | "rest"
> & {
  input?: TInputSchema;
  output?: TOutputSchema;
  hooks?: OperationHooksConfig<
    InferInput<TInputSchema>,
    InferOutput<TOutputSchema>,
    TInitData,
    TPathParams,
    TQueryParams,
    TBody
  >;
  rest?: RestConfigInput<TPathParams, TQueryParams, TBody>;
};

// Overload 1: Query-based operation (has `query`, no `handler`)
export function operation<
  TInputSchema extends z.ZodType | undefined = undefined,
  TOutputSchema extends z.ZodType | undefined = undefined,
  TInitData = unknown,
  TPathParams extends z.ZodType | undefined = undefined,
  TQueryParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
>(
  config: QueryOperationConfig<
    TInputSchema,
    TOutputSchema,
    TInitData,
    TPathParams,
    TQueryParams,
    TBody
  >,
): QueryOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData>;

// Overload 2: Handler-based operation without custom repository type (no generic provided)
export function operation<
  TInputSchema extends z.ZodType | undefined = undefined,
  TOutputSchema extends z.ZodType | undefined = undefined,
  TInitData = unknown,
  TPathParams extends z.ZodType | undefined = undefined,
  TQueryParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
>(
  config: HandlerOperationConfig<
    unknown,
    TInputSchema,
    TOutputSchema,
    TInitData,
    TPathParams,
    TQueryParams,
    TBody
  >,
): HandlerOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData, unknown>;

// Implementation
export function operation(config: unknown): unknown {
  return config;
}

/**
 * Creates a typed operation helper with custom repository type.
 * Use this when you need typed access to repository in the handler.
 *
 * The generic is the databases map, keyed by database name (the same keys as
 * `databases[].name`): at runtime `options.repository` holds one entry per
 * database, so access a database's repository with `repository[dbName]`.
 *
 * @example
 * ```ts
 * type MainRepository = {
 *   users: { create: (data: UserInput) => Promise<User> };
 * };
 *
 * const createUser = operation.typed<{ main: MainRepository }>()({
 *   input: z.object({ name: z.string(), email: z.string() }),
 *   handler: async ({ repository }, input) => {
 *     // repository is typed as { main: MainRepository }
 *     const user = await repository.main.users.create(input);
 *     return { id: user.id };
 *   },
 * });
 * ```
 */
operation.typed = <TRepository>() => {
  return <
    TInputSchema extends z.ZodType | undefined = undefined,
    TOutputSchema extends z.ZodType | undefined = undefined,
    TInitData = unknown,
    TPathParams extends z.ZodType | undefined = undefined,
    TQueryParams extends z.ZodType | undefined = undefined,
    TBody extends z.ZodType | undefined = undefined,
  >(
    config: HandlerOperationConfig<
      TRepository,
      TInputSchema,
      TOutputSchema,
      TInitData,
      TPathParams,
      TQueryParams,
      TBody
    >,
  ): HandlerOperation<
    InferInput<TInputSchema>,
    InferOutput<TOutputSchema>,
    TInitData,
    TRepository
  > => {
    return config as HandlerOperation<
      InferInput<TInputSchema>,
      InferOutput<TOutputSchema>,
      TInitData,
      TRepository
    >;
  };
};

// ============================================================================
// Type utilities for operations
// ============================================================================

/**
 * Infer the input type from an operation
 */
export type InferOperationInput<T> =
  T extends TypedOperation<infer TInput, unknown, unknown> ? TInput : never;

/**
 * Infer the output type from an operation
 */
export type InferOperationOutput<T> =
  T extends TypedOperation<unknown, infer TOutput, unknown> ? TOutput : never;

/**
 * Infer the init data type from an operation
 */
export type InferOperationInitData<T> =
  T extends TypedOperation<unknown, unknown, infer TInitData> ? TInitData : never;

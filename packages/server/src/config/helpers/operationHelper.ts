import { z } from "zod";

import type {
  DefaultInput,
  HandlerOperation,
  OperationHandler,
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
 * Config type for handler-based operations with inference
 */
type HandlerOperationConfig<
  TRepository,
  TInputSchema extends z.ZodType | undefined,
  TOutputSchema extends z.ZodType | undefined,
  TInitData,
> = Omit<
  HandlerOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData, TRepository>,
  "handler" | "input" | "output"
> & {
  input?: TInputSchema;
  output?: TOutputSchema;
  handler: OperationHandler<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TRepository>;
};

/**
 * Config type for query-based operations with inference
 */
type QueryOperationConfig<
  TInputSchema extends z.ZodType | undefined,
  TOutputSchema extends z.ZodType | undefined,
  TInitData,
> = Omit<
  QueryOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData>,
  "input" | "output"
> & {
  input?: TInputSchema;
  output?: TOutputSchema;
};

// Overload 1: Query-based operation (has `query`, no `handler`)
export function operation<
  TInputSchema extends z.ZodType | undefined = undefined,
  TOutputSchema extends z.ZodType | undefined = undefined,
  TInitData = unknown,
>(
  config: QueryOperationConfig<TInputSchema, TOutputSchema, TInitData>,
): QueryOperation<InferInput<TInputSchema>, InferOutput<TOutputSchema>, TInitData>;

// Overload 2: Handler-based operation without custom repository type (no generic provided)
export function operation<
  TInputSchema extends z.ZodType | undefined = undefined,
  TOutputSchema extends z.ZodType | undefined = undefined,
  TInitData = unknown,
>(
  config: HandlerOperationConfig<unknown, TInputSchema, TOutputSchema, TInitData>,
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
  >(
    config: HandlerOperationConfig<TRepository, TInputSchema, TOutputSchema, TInitData>,
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

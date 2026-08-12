import type { BackgroundCallbackOptions } from "../common";

// Re-export base types from the config module
export type {
  DefaultInput,
  BeforeRequestContext,
  AfterRequestContext,
  OperationRestConfig,
  OperationGraphQLConfig,
  OperationCacheConfig,
  OperationInitHook,
  OperationBeforeRequestHook,
  OperationAfterRequestHook,
  OperationHandler,
  BaseOperation,
  QueryOperation,
  HandlerOperation,
  TypedOperation,
  GqlQueryResult,
  Operation,
  Operations,
} from "../../config";

// Re-export Zod schemas from config
export {
  OperationRestConfigZod,
  OperationGraphQLConfigZod,
  OperationCacheConfigZod,
  OperationZod,
  OperationsZod,
} from "../../config";

/**
 * Options passed to operation handlers and hooks
 * This is the runtime version with fully typed Bun-specific options
 */
export type OperationOptions<TRepository = unknown> = BackgroundCallbackOptions<TRepository>;

/**
 * The typed tRPC router of a configuration, for `createTRPCClient`.
 *
 * Exposed as `@graphoria/server/trpc`. Types only: nothing here runs, and the
 * client needs no code generation.
 *
 * @example
 * ```ts
 * import { createTRPCClient, httpBatchLink } from "@trpc/client";
 *
 * import type { TRPCRouterOf } from "@graphoria/server/trpc";
 * import type config from "../graphoria";
 *
 * const client = createTRPCClient<TRPCRouterOf<typeof config>>({
 *   links: [httpBatchLink({ url: "/trpc", maxItems: 10 })],
 * });
 * ```
 */
import type {
  TRPCBuiltRouter,
  TRPCDefaultErrorShape,
  TRPCMutationProcedure,
  TRPCQueryProcedure,
} from "@trpc/server";
import type { OperationTypes } from "../config";

type OperationsOf<TConfig> = TConfig extends (...args: never[]) => infer TReturn
  ? OperationsOf<TReturn>
  : TConfig extends { operations: infer TOperations }
    ? TOperations
    : never;

type ProcedureOf<TOperation> =
  TOperation extends OperationTypes<infer TMethod, infer TInput, infer TOutput>
    ? TMethod extends "GET"
      ? TRPCQueryProcedure<{ input: TInput; output: TOutput; meta: object }>
      : TRPCMutationProcedure<{ input: TInput; output: TOutput; meta: object }>
    : never;

/**
 * The router type of a configuration: one procedure per operation made with
 * `operation()` or `operation.typed()`, a query when its `rest.method` is `GET`
 * and a mutation otherwise. `TConfig` is the configuration function or object,
 * kept literal with `satisfies ConfigurationFn`.
 */
export type TRPCRouterOf<TConfig> = TRPCBuiltRouter<
  { ctx: object; meta: object; errorShape: TRPCDefaultErrorShape; transformer: false },
  {
    [
      TName in keyof OperationsOf<TConfig> as [ProcedureOf<OperationsOf<TConfig>[TName]>] extends [
        never,
      ]
        ? never
        : TName
    ]: ProcedureOf<OperationsOf<TConfig>[TName]>;
  }
>;

/**
 * The typed tRPC router of a configuration, for `createTRPCClient`.
 *
 * Exposed as `@graphoria/server/trpc`. Types only: nothing here runs. An
 * operation with a plain-string `query` and no `output` takes its output type
 * from the `graphoria-env.d.ts` that `graphoria codegen` writes.
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

declare global {
  /**
   * The outputs `graphoria codegen` writes into `graphoria-env.d.ts`, one per
   * plain-string operation, keyed by name. Global, not a module augmentation: an
   * augmentation reaches only a client that resolves the server's own copy of
   * this package.
   */
  // Empty here: graphoria-env.d.ts adds the members.
  // oxlint-disable-next-line typescript/no-empty-object-type
  interface GraphoriaGeneratedOperationOutputs {}
}

// `0 extends 1 & TOutput` holds only for `any`, which `unknown extends` would
// otherwise turn into `unknown`.
type OutputOf<TName, TOutput> = 0 extends 1 & TOutput
  ? TOutput
  : unknown extends TOutput
    ? TName extends keyof GraphoriaGeneratedOperationOutputs
      ? GraphoriaGeneratedOperationOutputs[TName]
      : unknown
    : TOutput;

type OperationsOf<TConfig> = TConfig extends (...args: never[]) => infer TReturn
  ? OperationsOf<TReturn>
  : TConfig extends { operations: infer TOperations }
    ? TOperations
    : never;

type ProcedureOf<TName, TOperation> =
  TOperation extends OperationTypes<infer TMethod, infer TInput, infer TOutput>
    ? TMethod extends "GET"
      ? TRPCQueryProcedure<{ input: TInput; output: OutputOf<TName, TOutput>; meta: object }>
      : TRPCMutationProcedure<{ input: TInput; output: OutputOf<TName, TOutput>; meta: object }>
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
      TName in keyof OperationsOf<TConfig> as [
        ProcedureOf<TName, OperationsOf<TConfig>[TName]>,
      ] extends [never]
        ? never
        : TName
    ]: ProcedureOf<TName, OperationsOf<TConfig>[TName]>;
  }
>;

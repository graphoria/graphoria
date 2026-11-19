export type TrpcRuntime = typeof import("./runtime");

// Resolving first tells a missing package apart from one that fails to load: a
// load error (a broken install, another @trpc/server major) surfaces as is.
export const importTrpcRuntime = async (): Promise<TrpcRuntime | undefined> => {
  try {
    import.meta.resolve("@trpc/server");
  } catch {
    return undefined;
  }
  return import("./runtime");
};

export type TrpcDependencies = {
  /** Test seam: the runtime loads through this; `undefined` when @trpc/server is not installed. */
  importRuntime?: () => Promise<TrpcRuntime | undefined>;
};

/**
 * The tRPC runtime, loaded when the surface is on. `./runtime` is the only
 * module that imports `@trpc/server` values, so with the surface off nothing
 * from tRPC is loaded and the package can stay uninstalled.
 */
export const loadTrpcRuntime = async ({
  importRuntime = importTrpcRuntime,
}: TrpcDependencies = {}): Promise<TrpcRuntime> => {
  const runtime = await importRuntime();
  if (!runtime) throw new Error("TRPC_ENABLED requires @trpc/server (add it to dependencies)");

  return runtime;
};

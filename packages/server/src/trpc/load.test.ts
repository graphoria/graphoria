import { describe, expect, it } from "bun:test";

import { loadTrpcRuntime } from "./load";

describe("tRPC runtime discovery", () => {
  it("fails the boot naming the switch when @trpc/server is not installed", async () => {
    await expect(loadTrpcRuntime({ importRuntime: async () => undefined })).rejects.toThrow(
      "TRPC_ENABLED requires @trpc/server (add it to dependencies)",
    );
  });

  it("surfaces the runtime's own error when it fails to load", async () => {
    await expect(
      loadTrpcRuntime({
        importRuntime: async () => {
          throw new Error("Cannot find module '@trpc/server/adapters/fetch'");
        },
      }),
    ).rejects.toThrow("Cannot find module '@trpc/server/adapters/fetch'");
  });

  it("loads the runtime when the package is installed", async () => {
    const runtime = await loadTrpcRuntime();

    expect(runtime.createTRPCHandler).toBeTypeOf("function");
  });
});

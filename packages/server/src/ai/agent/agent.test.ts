process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, describe, expect, it } from "bun:test";

import type { Provider } from "./types";

const { ask } = await import("./agent");
const { setProvider } = await import("./providers");

describe("ask — LLM call timeout", () => {
  afterEach(() => setProvider(null));

  it("gives up on a provider call that outlives the timeout", async () => {
    // Fails at once rather than hanging when no timeout reaches the provider:
    // `expect(...).rejects` on a promise nothing settles stalls the runner.
    const hanging: Provider = {
      chat: (_messages, _tools, signal) =>
        new Promise((_, reject) => {
          if (!signal) return reject(new Error("no timeout reached the provider"));
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    };
    setProvider(hanging);

    await expect(ask("q", [], "system", (prompt) => prompt, 20)).rejects.toThrow(
      "LLM call timed out after 20 ms",
    );
  });

  it("keeps the provider's own abort error as the timeout's cause", async () => {
    const aborted = new Error("Request was aborted.");
    setProvider({
      chat: (_messages, _tools, signal) =>
        new Promise((_, reject) => {
          if (!signal) return reject(new Error("no timeout reached the provider"));
          signal.addEventListener("abort", () => reject(aborted));
        }),
    });

    const error = await ask("q", [], "system", (prompt) => prompt, 20).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe("LLM call timed out after 20 ms");
    expect((error as Error).cause).toBe(aborted);
  });

  it("hands the provider no signal while the timeout is off", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    setProvider({
      chat: async (_messages, _tools, signal) => {
        signals.push(signal);
        throw new Error("stop");
      },
    });

    await expect(ask("q", [], "system", (prompt) => prompt, 0)).rejects.toThrow("stop");
    expect(signals).toEqual([undefined]);
  });

  it("passes a provider's own failure through unchanged while the timeout has not fired", async () => {
    const failure = new Error("401 Unauthorized");
    setProvider({
      chat: async () => {
        throw failure;
      },
    });

    await expect(ask("q", [], "system", (prompt) => prompt, 60_000)).rejects.toBe(failure);
  });
});

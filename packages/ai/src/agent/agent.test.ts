process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, describe, expect, it } from "bun:test";

import { z } from "zod";

import type { AiToolDeps, Provider } from "@graphoria/server";

const { ask } = await import("./agent");
const { setProvider } = await import("./providers");

/** `ask` logs through the deps' logger; the tests need no output. */
const logger = (() => ({
  debug() {},
  warn() {},
  error() {},
  info() {},
  fatal() {},
  trace() {},
  silent() {},
  child() {
    return logger;
  },
  level: "silent" as const,
})) as unknown as AiToolDeps["logger"];

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

    await expect(ask(logger, "q", [], "system", (prompt) => prompt, 20)).rejects.toThrow(
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

    const error = await ask(logger, "q", [], "system", (prompt) => prompt, 20).catch(
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

    await expect(ask(logger, "q", [], "system", (prompt) => prompt, 0)).rejects.toThrow("stop");
    expect(signals).toEqual([undefined]);
  });

  it("passes a provider's own failure through unchanged while the timeout has not fired", async () => {
    const failure = new Error("401 Unauthorized");
    setProvider({
      chat: async () => {
        throw failure;
      },
    });

    await expect(ask(logger, "q", [], "system", (prompt) => prompt, 60_000)).rejects.toBe(failure);
  });
});

describe("ask — empty answers", () => {
  afterEach(() => setProvider(null));

  const queryTool = {
    name: "query_data",
    description: "",
    schema: z.object({}),
    execute: async () => ({ data: [{ count: 3 }] }),
  };

  it("asks again when the model answers nothing, then returns the retry", async () => {
    let calls = 0;
    setProvider({
      chat: async () => {
        calls += 1;
        if (calls === 1)
          return {
            content: "",
            toolCalls: [{ id: "call-1", function: { name: "query_data", arguments: {} } }],
          };
        if (calls === 2) return { content: "   ", toolCalls: [] };
        return { content: "3 books", toolCalls: [] };
      },
    });

    const answer = await ask(logger, "how many?", [queryTool], "system", (prompt) => prompt);

    expect(answer).toBe("3 books");
    expect(calls).toBe(3);
  });

  it("fails loudly after repeated empty answers", async () => {
    setProvider({
      chat: async () => ({ content: "", toolCalls: [], finishReason: "length" }),
    });

    await expect(ask(logger, "q", [], "system", (prompt) => prompt)).rejects.toThrow(
      "The model returned an empty answer",
    );
  });
});

describe("ask — repeated tool calls", () => {
  afterEach(() => setProvider(null));

  it("runs an identical call once and hands the model its cached result", async () => {
    let calls = 0;
    let executions = 0;
    let lastToolMessage = "";
    setProvider({
      chat: async (messages) => {
        calls += 1;
        if (calls === 3)
          lastToolMessage = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
        if (calls <= 2)
          return {
            content: "",
            toolCalls: [{ id: `call-${calls}`, function: { name: "query_data", arguments: {} } }],
          };
        return { content: "done", toolCalls: [] };
      },
    });
    const queryTool = {
      name: "query_data",
      description: "",
      schema: z.object({}),
      execute: async () => {
        executions += 1;
        return { data: [{ id: 1 }] };
      },
    };

    const answer = await ask(logger, "q", [queryTool], "system", (prompt) => prompt);

    expect(answer).toBe("done");
    expect(executions).toBe(1);
    expect(lastToolMessage).toContain("already ran");
    expect(lastToolMessage).toContain('"id":1');
  });
});

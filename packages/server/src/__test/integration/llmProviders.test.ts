import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { INTEGRATION_ENABLED } from "./config";

/**
 * Each LLM provider hands the agent's signal to its HTTP call: against a server
 * that never answers, the call rejects once the signal fires instead of
 * hanging.
 *
 * Integration lane, not unit: the unit preload's happy-dom makes both SDK
 * clients refuse to construct and replaces AbortSignal with one Bun's fetch
 * rejects outright, so a unit test here would pass for the wrong reason.
 */

const ABORTED = /aborted|timed out/;

describe.skipIf(!INTEGRATION_ENABLED)("LLM providers abort on the agent's signal", () => {
  let server: ReturnType<typeof Bun.serve>;
  let ollamaConfig: { host: string };
  let previousOllamaHost: string;
  let previousAnthropicUrl: string | undefined;

  const message = [{ role: "user" as const, content: "hi" }];
  const url = () => `http://localhost:${server.port}`;

  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });

    ({ config: ollamaConfig } = await import("../../ai/agent/providers/ollama"));
    previousOllamaHost = ollamaConfig.host;
    ollamaConfig.host = url();

    previousAnthropicUrl = process.env["ANTHROPIC_BASE_URL"];
    process.env["ANTHROPIC_BASE_URL"] = url();
  });

  afterAll(() => {
    server.stop(true);
    ollamaConfig.host = previousOllamaHost;
    if (previousAnthropicUrl === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = previousAnthropicUrl;
  });

  it("ollama", async () => {
    const { ollamaProvider } = await import("../../ai/agent/providers/ollama");

    await expect(ollamaProvider.chat(message, [], AbortSignal.timeout(50))).rejects.toThrow(
      ABORTED,
    );
  });

  it("openai-compatible", async () => {
    const { makeOpenAICompatible } = await import("../../ai/agent/providers/openai");
    const provider = makeOpenAICompatible({ apiKey: "test", model: "m", baseURL: url() });

    await expect(provider.chat(message, [], AbortSignal.timeout(50))).rejects.toThrow(ABORTED);
  });

  it("anthropic", async () => {
    const { makeAnthropic } = await import("../../ai/agent/providers/anthropic");
    const provider = makeAnthropic({ apiKey: "test", model: "m" });

    await expect(provider.chat(message, [], AbortSignal.timeout(50))).rejects.toThrow(ABORTED);
  });
});

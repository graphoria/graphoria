import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { Message } from "@graphoria/server";

import { getProvider } from "../src/agent/providers";
import { makeAnthropic } from "../src/agent/providers/anthropic";
import { makeOpenAICompatible } from "../src/agent/providers/openai";

/**
 * What each provider sends when the environment names no model. Each default
 * model rejects part of a plain request: Claude Haiku 5.5 any temperature but 1,
 * GPT-6 Luna tools over Chat Completions unless reasoning is off, and DeepSeek in
 * thinking mode, its default, a tool conversation that does not send each
 * reply's reasoning back.
 *
 * Integration lane, not unit: the unit preload's happy-dom makes both SDK
 * clients refuse to construct.
 */

const ENV = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

const CHAT_COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

const ANTHROPIC_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe.skipIf(!process.env.INTEGRATION)("what each provider sends", () => {
  const originalFetch = globalThis.fetch;
  const savedEnv = new Map<string, string | undefined>();
  let sent: Array<{ url: string; body: Record<string, unknown> }>;

  const message: Message[] = [{ role: "user", content: "hi" }];

  /**
   * Answers every request with `reply` and records it. Call it before the SDK
   * client is built: the client keeps the fetch it finds then.
   */
  const answerWith = (reply: object) => {
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
      return Response.json(reply);
    }) as unknown as typeof globalThis.fetch;
  };

  beforeEach(() => {
    sent = [];
    for (const key of ENV) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("openai: gpt-6-luna, with reasoning off so it can call tools", async () => {
    process.env["LLM_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "test";
    answerWith(CHAT_COMPLETION);

    await (await getProvider()).chat(message, []);

    expect(sent.map((r) => r.url)).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(sent[0]?.body).toMatchObject({
      model: "gpt-6-luna",
      reasoning_effort: "none",
      temperature: 0,
    });
  });

  it("deepseek: deepseek-flash, out of thinking mode", async () => {
    process.env["LLM_PROVIDER"] = "deepseek";
    process.env["DEEPSEEK_API_KEY"] = "test";
    answerWith(CHAT_COMPLETION);

    await (await getProvider()).chat(message, []);

    expect(sent.map((r) => r.url)).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect(sent[0]?.body).toMatchObject({
      model: "deepseek-flash",
      reasoning_effort: "none",
      temperature: 0,
    });
  });

  it("anthropic: claude-haiku-5-5, with no temperature", async () => {
    process.env["LLM_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test";
    answerWith(ANTHROPIC_MESSAGE);

    await (await getProvider()).chat(message, []);

    expect(sent.map((r) => r.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(sent[0]?.body).toMatchObject({ model: "claude-haiku-5-5" });
    expect(sent[0]?.body).not.toHaveProperty("temperature");
  });

  it("anthropic sends a temperature that is configured", async () => {
    answerWith(ANTHROPIC_MESSAGE);

    await makeAnthropic({ apiKey: "test", model: "m", temperature: 0.5 }).chat(message, []);

    expect(sent[0]?.body).toMatchObject({ temperature: 0.5 });
  });

  it("leaves reasoning_effort out unless it is configured", async () => {
    answerWith(CHAT_COMPLETION);

    await makeOpenAICompatible({
      apiKey: "test",
      model: "m",
      baseURL: "http://compatible.test/v1",
    }).chat(message, []);

    expect(sent.map((r) => r.url)).toEqual(["http://compatible.test/v1/chat/completions"]);
    expect(sent[0]?.body).not.toHaveProperty("reasoning_effort");
  });
});

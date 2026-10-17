import { describe, expect, it } from "bun:test";

import { DEFAULT_MODELS } from "./index";

describe("DEFAULT_MODELS", () => {
  // Every agent without LLM_MODEL runs and pays for these, so a change has to be deliberate.
  it("pins each provider's model", () => {
    expect(DEFAULT_MODELS).toEqual({
      ollama: "qwen3.5:2b",
      openai: "gpt-6-luna",
      deepseek: "deepseek-flash",
      anthropic: "claude-haiku-5-5",
    });
  });
});

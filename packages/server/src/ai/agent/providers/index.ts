import type { Provider } from "../types";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required for LLM_PROVIDER="${process.env.LLM_PROVIDER}".`);
  }
  return value;
}

// Provider registry. Each factory dynamically imports its module so the
// provider SDK is loaded into memory ONLY when that provider is selected.
// Add OpenAI-compatible backends (Groq, Mistral, Together, …) as one more
// entry pointing makeOpenAICompatible at their baseURL.
const REGISTRY: Record<string, () => Promise<Provider>> = {
  ollama: async () => {
    const { ollamaProvider } = await import("./ollama");
    return ollamaProvider;
  },

  openai: async () => {
    const { makeOpenAICompatible } = await import("./openai");
    return makeOpenAICompatible({
      apiKey: requireEnv("OPENAI_API_KEY"),
      baseURL: process.env.OPENAI_BASE_URL, // undefined → SDK default (api.openai.com)
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    });
  },

  deepseek: async () => {
    const { makeOpenAICompatible } = await import("./openai");
    return makeOpenAICompatible({
      apiKey: requireEnv("DEEPSEEK_API_KEY"),
      baseURL: "https://api.deepseek.com",
      model: process.env.LLM_MODEL ?? "deepseek-chat",
    });
  },

  anthropic: async () => {
    const { makeAnthropic } = await import("./anthropic");
    return makeAnthropic({
      apiKey: requireEnv("ANTHROPIC_API_KEY"),
      model: process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001",
    });
  },
};

/**
 * Resolve the active LLM provider from `LLM_PROVIDER` (default "ollama").
 * The provider module (and its SDK) is dynamically imported on demand, so
 * unused provider SDKs never load. Each provider reads its own env vars lazily.
 */
export function getProvider(): Promise<Provider> {
  const name = (process.env.LLM_PROVIDER ?? "ollama").toLowerCase();
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(
      `Unknown LLM_PROVIDER "${name}". Valid options: ${Object.keys(REGISTRY).join(", ")}.`,
    );
  }
  return factory();
}

import type { ChatResult, Message, Provider, ToolDefinition } from "../types";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
// LLM_MODEL is the unified knob; OLLAMA_MODEL kept for backward compatibility.
const OLLAMA_MODEL = process.env.LLM_MODEL ?? process.env.OLLAMA_MODEL ?? "qwen3.5:2b";

export const config = {
  host: OLLAMA_HOST,
  model: OLLAMA_MODEL,
};

// ---- Per-model presets for optimal accuracy ----
// Keyed by model family prefix (matched case-insensitive).

interface ModelPreset {
  temperature: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
  seed?: number;
}

const PRESETS: Record<string, ModelPreset> = {
  // Google Gemma 4 — recommended sampling params from official docs
  gemma4: { temperature: 1.0, top_p: 0.95, top_k: 64 },

  // Meta Llama 3.x — temp 0 kills hallucination on small models
  llama3: { temperature: 0, num_predict: 2048 },

  // Alibaba Qwen 3.x — low temp for deterministic tool use
  qwen3: { temperature: 0.1, top_p: 0.9 },

  // IBM Granite 4 — conservative sampling
  granite4: { temperature: 0.1 },

  // Google FunctionGemma — tiny, keep deterministic
  functiongemma: { temperature: 0 },

  // Default fallback — safe for unknown models
  default: { temperature: 0, top_p: 0.9 },
};

function resolvePreset(model: string): ModelPreset {
  const key = model.toLowerCase();
  for (const [prefix, preset] of Object.entries(PRESETS)) {
    if (key.startsWith(prefix)) return preset;
  }
  return PRESETS.default!;
}

// ---- Ollama wire format ----

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message: { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] };
}

/** Serialize normalized history → Ollama's wire shape (tool results keyed by tool_name). */
function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  return messages.map((m): OllamaMessage => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.tool_name };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Native Ollama provider. Talks to /api/chat directly (no SDK) and keeps the
 * per-model sampling presets. Default provider — runs local/free, no API key.
 */
export const ollamaProvider: Provider = {
  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResult> {
    const preset = resolvePreset(config.model);

    const body = {
      model: config.model,
      messages: toOllamaMessages(messages),
      tools,
      stream: false,
      options: {
        temperature: preset.temperature,
        top_p: preset.top_p,
        top_k: preset.top_k,
        num_predict: preset.num_predict,
        seed: preset.seed,
      },
    };

    const res = await fetch(`${config.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error ${res.status} (${res.statusText}): ${text}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const toolCalls = (data.message.tool_calls ?? []).map((tc, i) => ({
      id: `ollama-${i}`, // Ollama omits ids; synthesize one for correlation.
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return { content: data.message.content ?? "", toolCalls };
  },
};

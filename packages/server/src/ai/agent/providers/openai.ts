import OpenAI from "openai";
import type { ChatResult, Message, Provider, ToolDefinition } from "../types";

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OAITool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface OpenAICompatConfig {
  apiKey: string;
  model: string;
  /** Override for OpenAI-compatible endpoints (DeepSeek, Groq, Mistral, …). */
  baseURL?: string;
  temperature?: number;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Serialize normalized history → OpenAI Chat Completions messages. */
function toOpenAIMessages(messages: Message[]): OAIMessage[] {
  return messages.map((m): OAIMessage => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return m.tool_calls && m.tool_calls.length > 0
          ? {
              role: "assistant",
              content: m.content || null,
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.function.name,
                  arguments: JSON.stringify(tc.function.arguments),
                },
              })),
            }
          : { role: "assistant", content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: m.content };
      default: {
        const _exhaustive: never = m.role;
        throw new Error(`Unhandled message role: ${String(_exhaustive)}`);
      }
    }
  });
}

function toOpenAITools(tools: ToolDefinition[]): OAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

/**
 * Provider for any OpenAI-compatible Chat Completions endpoint.
 * Used for OpenAI, DeepSeek, and other compatible servers via `baseURL`.
 */
export function makeOpenAICompatible(cfg: OpenAICompatConfig): Provider {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  const temperature = cfg.temperature ?? 0;

  return {
    async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResult> {
      const res = await client.chat.completions.create({
        model: cfg.model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        temperature,
      });

      const msg = res.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).flatMap((tc) =>
        tc.type === "function"
          ? [
              {
                id: tc.id,
                function: { name: tc.function.name, arguments: parseArgs(tc.function.arguments) },
              },
            ]
          : [],
      );

      return { content: msg?.content ?? "", toolCalls };
    },
  };
}

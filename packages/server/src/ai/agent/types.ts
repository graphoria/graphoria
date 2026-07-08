// ---- Tool definitions (OpenAI-compatible JSON Schema) ----

import type { z } from "zod";

export interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunction;
}

// ---- Unified tool (Zod schema + executor in one place) ----

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  execute: (args: z.infer<TSchema>) => Promise<unknown>;
}

// ---- Normalized messages (provider-agnostic) ----

export interface ToolCall {
  /** Correlation id. Synthesized for providers that omit one (Ollama). */
  id: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  /** Tool-result correlation id (OpenAI tool_call_id / Anthropic tool_use_id). */
  tool_call_id?: string;
  /** Tool name for Ollama tool-result messages. */
  tool_name?: string;
}

// ---- Provider abstraction ----

/** Normalized result of one chat turn, independent of provider wire format. */
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

/**
 * A chat backend. Each implementation translates the normalized message/tool
 * history to and from its provider's wire format. Stateless: the full message
 * history is passed on every call.
 */
export interface Provider {
  chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResult>;
}

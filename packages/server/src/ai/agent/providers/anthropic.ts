import Anthropic from "@anthropic-ai/sdk";
import type { ChatResult, Message, Provider, ToolCall, ToolDefinition } from "../types";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

function toAnthropicTool(t: ToolDefinition): Anthropic.Tool {
  return {
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool["input_schema"],
  };
}

/**
 * Serialize normalized history → Anthropic's wire shape.
 * - `system` messages are extracted to the top-level `system` param.
 * - consecutive `tool` results are coalesced into a single user message of
 *   tool_result blocks (Anthropic requires them grouped after the assistant turn).
 */
function toAnthropicMessages(messages: Message[]): {
  system: string | undefined;
  anthropicMessages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }

    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    // role === "tool" → tool_result block, grouped into a trailing user message.
    const block: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: m.tool_call_id ?? "",
      content: m.content,
    };
    const last = out[out.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }

  return { system, anthropicMessages: out };
}

/** Provider for Anthropic's Messages API (Claude). */
export function makeAnthropic(cfg: AnthropicConfig): Provider {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const maxTokens = cfg.maxTokens ?? 4096;
  const temperature = cfg.temperature ?? 0;

  return {
    async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResult> {
      const { system, anthropicMessages } = toAnthropicMessages(messages);

      const res = await client.messages.create({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature,
        system,
        tools: tools.map(toAnthropicTool),
        messages: anthropicMessages,
      });

      let content = "";
      const toolCalls: ToolCall[] = [];
      for (const block of res.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            function: {
              name: block.name,
              arguments: (block.input ?? {}) as Record<string, unknown>,
            },
          });
        }
      }

      return { content, toolCalls };
    },
  };
}

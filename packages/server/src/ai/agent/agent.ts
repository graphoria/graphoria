import { z } from "zod";
import type { Message, Tool, ToolDefinition } from "./types";
import { getProvider } from "./providers";
import { logger } from "../../logging";

const MAX_ITERATIONS = 10;

/** Strip null values from tool-call arguments — LLMs pass `null` for optional fields instead of omitting them. */
function stripNulls(args: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(args)) {
    if (args[key] === null) delete args[key];
  }
  return args;
}

/** Minimal view of a Zod 4 internal def for schema introspection. */
type ZodDef = { type: string; innerType?: ZodLike; shape?: Record<string, ZodLike> };
type ZodLike = { def?: ZodDef };

/** Unwrap optional/default/nullable to the base Zod type. */
function baseType(field: ZodLike): ZodLike {
  let cur = field;
  while (
    cur.def &&
    ["optional", "default", "nullable"].includes(cur.def.type) &&
    cur.def.innerType
  ) {
    cur = cur.def.innerType;
  }
  return cur;
}

/**
 * JSON.parse string args whose schema target is a structured/scalar type.
 * Small LLMs send `'["a"]'` or `'true'` as strings; parse before Zod validation.
 */
function coerceJsonStrings(
  schema: z.ZodTypeAny,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const shape = (schema as unknown as ZodLike).def?.shape;
  if (!shape) return args;
  for (const key of Object.keys(args)) {
    if (typeof args[key] !== "string" || !shape[key]) continue;
    const t = baseType(shape[key]).def?.type;
    if (t && ["array", "object", "record", "number", "boolean"].includes(t)) {
      try {
        args[key] = JSON.parse(args[key] as string);
      } catch {
        /* let Zod reject */
      }
    }
  }
  return args;
}

/** Convert a Zod-based Tool to an OpenAI-compatible ToolDefinition. */
function toToolDefinition(tool: Tool): ToolDefinition {
  const jsonSchema = z.toJSONSchema(tool.schema);
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema as ToolDefinition["function"]["parameters"],
    },
  };
}

// ---- Factory ----

/** Pre-bound agent config. Use with {@link createAgent}. */
export interface AgentConfig {
  tools: Tool[];
  systemPrompt: string;
  /** Wraps the raw user prompt into the final user message sent to the LLM. */
  wrap: (content: string) => string;
}

/**
 * Create a pre-configured agent function. Bind tools, system prompt, and prompt
 * wrapper once — call with just a prompt string any number of times.
 *
 * @example
 *   const ask = createAgent({
 *     tools,
 *     systemPrompt: "You are a database assistant...",
 *     wrap: (prompt) => `Database-query from user:\n> ${prompt}`,
 *   });
 *   const answer = await ask("list all contacts grouped by role");
 */
export function createAgent(config: AgentConfig): (prompt: string) => Promise<string> {
  return (prompt: string) => ask(prompt, config.tools, config.systemPrompt, config.wrap);
}

// ---- Core agent loop ----

/**
 * Send a prompt to the LLM and return ONLY the final text answer.
 * Handles tool-calling loops internally — the caller never sees tool calls.
 *
 * Use {@link createAgent} for a pre-configured single-arg version.
 *
 * @example
 *   const answer = await ask(
 *     "list all contacts grouped by role",
 *     tools,
 *     "You are a database assistant...",
 *     (prompt) => `Database-query from user:\n> ${prompt}`,
 *   );
 */
export async function ask(
  prompt: string,
  tools: Tool[],
  systemPrompt: string,
  wrap: (content: string) => string,
): Promise<string> {
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: wrap(prompt) },
  ];

  const provider = await getProvider();
  const toolDefs: ToolDefinition[] = tools.map(toToolDefinition);
  const log = logger("ai-agent");

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    log.debug({ iteration: i + 1 }, "agent iteration");

    const { content, toolCalls } = await provider.chat(messages, toolDefs);

    // If the model returned tool calls, execute them and feed results back
    if (toolCalls.length > 0) {
      log.debug({ toolCallCount: toolCalls.length }, "model requested tool calls");

      // Append assistant message (with tool_calls) to history
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls,
      });

      // Execute each tool and append results
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const rawArgs = tc.function.arguments;

        log.debug({ tool: toolName, args: rawArgs }, "calling tool");

        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
          log.warn({ tool: toolName }, "unknown tool requested by model");
          messages.push({
            role: "tool",
            content: JSON.stringify({
              error: `Unknown tool: ${toolName}`,
            }),
            tool_name: toolName,
            tool_call_id: tc.id,
          });
          continue;
        }

        try {
          // Strip nulls, coerce stringified JSON (LLM robustness), then validate via Zod
          const cleanedArgs = coerceJsonStrings(tool.schema, stripNulls(rawArgs));
          const parsedArgs = tool.schema.parse(cleanedArgs);
          const result = await tool.execute(parsedArgs);
          const resultStr = JSON.stringify(result);

          log.debug({ tool: toolName, resultLength: resultStr.length }, "tool returned");

          messages.push({
            role: "tool",
            content: resultStr,
            tool_name: toolName,
            tool_call_id: tc.id,
          });
        } catch (err) {
          log.warn({ tool: toolName, err }, "tool execution failed");
          messages.push({
            role: "tool",
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
            tool_name: toolName,
            tool_call_id: tc.id,
          });
        }
      }

      // Continue loop — feed tool results back to model
      continue;
    }

    // No tool calls — this is the final answer
    // Guard: if model never called query_data or graphql_execute, it's likely hallucinating
    const calledTools = messages
      .filter((m) => m.role === "assistant" && m.tool_calls)
      .flatMap((m) => m.tool_calls!.map((tc) => tc.function.name));

    const hasDescribed = calledTools.includes("describe_entity");
    const hasQueried = calledTools.includes("query_data");
    const hasGraphql = calledTools.includes("graphql_execute");

    if (!hasQueried && !hasGraphql) {
      log.warn("model attempted answer without querying data, nudging");
      messages.push({
        role: "user",
        content: hasDescribed
          ? "STOP — you haven't queried the data yet. Call query_data with the entity and columns from describe_entity. Use operation 'aggregate' with groupBy for grouping. Do NOT fabricate data."
          : "STOP — you skipped steps. Call describe_entity to get the table schema, then query_data to run the query. Do NOT fabricate data.",
      });
      continue;
    }

    log.debug({ answerLength: content.length }, "model answered directly");
    return content;
  }

  throw new Error(`Agent loop exceeded ${MAX_ITERATIONS} iterations without a final answer.`);
}

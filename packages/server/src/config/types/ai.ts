import { z } from "zod";

/**
 * Model Context Protocol (MCP) server configuration, nested under `ai.mcp`.
 * When enabled, exposes a `/mcp` endpoint for LLM agents.
 */
export const MCPZod = z.object({
  /** Whether the MCP server is enabled. Off by default. */
  enabled: z.boolean().default(false),
});

/** Authoring type for MCP configuration */
export type MCPConfig = z.input<typeof MCPZod>;

/**
 * AI agent configuration. Exposes an admin-only natural-language → database
 * Q&A agent as a GraphQL `ask` query and a REST `POST` endpoint.
 *
 * The LLM provider, model, and API keys are read from environment variables
 * (`LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 * `DEEPSEEK_API_KEY`, `OLLAMA_HOST`), not from this config.
 */
export const AIZod = z.object({
  /** Whether the AI agent is enabled. Off by default. */
  enabled: z.boolean().default(false),
  /** Overrides the built-in system prompt sent to the LLM. */
  systemPrompt: z.string().optional(),
  /** REST endpoint path for the agent (default: "/ai"). */
  endpoint: z.string().default("/ai"),
  /** Model Context Protocol (MCP) server. Off by default. See MCP.md. */
  mcp: MCPZod.optional().default({ enabled: false }),
});

/** Authoring type for AI configuration */
export type AIConfig = z.input<typeof AIZod>;

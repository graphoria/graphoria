# ollama_helper

An LLM-powered database query agent that uses tool-calling to discover a PostgreSQL schema, inspect tables, and execute queries — all from a natural language prompt. It is **cross-LLM**: the same agent runs against Ollama (default, local), OpenAI, DeepSeek, Anthropic, and any OpenAI-compatible endpoint — selected with a single env var.

## How It Works

```
User prompt
    │
    ▼
┌─────────────────────────────────────────────────┐
│  createAgent({ tools, systemPrompt, wrap })     │
│  → (prompt) => Promise<string>                  │
│                                                 │
│  Agent loop (ask function)                      │
│  1. Send systemPrompt + wrap(prompt) to LLM     │
│  2. LLM responds with tool_calls?               │
│     ├─ Yes → strip nulls, validate via Zod,     │
│     │        execute tool, feed result back      │
│     └─ No  → return final answer                │
│  3. Repeat until answer or max iters            │
└─────────────────────────────────────────────────┘
    │
    ▼
Final answer (text only — tool calls hidden)
```

The agent follows a fixed 4-step discovery workflow for every query:

| Step | Tool              | Purpose                                             |
| ---- | ----------------- | --------------------------------------------------- |
| 1    | `list_entities`   | Find relevant database tables by keyword search     |
| 2    | `describe_entity` | Get column names, types, and relationships          |
| 3    | `query_data`      | Execute the query using structured JSON (preferred) |
| 3\*  | `graphql_execute` | Raw GraphQL fallback for complex queries            |
| 4    | —                 | Present results as a Markdown table                 |

Anti-hallucination guards prevent the model from answering without actually querying data.

## Quick Start

**Prerequisites:** an LLM backend. The default is [Ollama](https://ollama.com) (local, free, no API key) running a tool-capable model. To use a hosted provider instead, set `LLM_PROVIDER` and the matching API key (see [Providers](#providers)).

```bash
# Install dependencies
bun install

# Run with the default provider (Ollama) and default prompt
bun run index.ts

# Custom prompt
bun run index.ts "how many students have an active subscription?"

# Switch providers via env vars
LLM_PROVIDER=openai    LLM_MODEL=gpt-4o-mini               OPENAI_API_KEY=sk-...        bun run index.ts "list all events"
LLM_PROVIDER=deepseek  LLM_MODEL=deepseek-chat             DEEPSEEK_API_KEY=sk-...      bun run index.ts "list all events"
LLM_PROVIDER=anthropic LLM_MODEL=claude-haiku-4-5-20251001 ANTHROPIC_API_KEY=sk-ant-... bun run index.ts "list all events"
```

### Using as a library

```typescript
import { createAgent } from "ollama_helper";
import { tools } from "./src/tools";

// Bind domain config once — call with just a prompt
const ask = createAgent({
  tools,
  systemPrompt: "You are a database assistant…",
  wrap: (prompt) => `Database query:\n> ${prompt}`,
});

const answer = await ask("list contacts grouped by role");
```

## Environment Variables

| Variable            | Default                  | Description                                                 |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| `LLM_PROVIDER`      | `ollama`                 | Backend: `ollama`, `openai`, `deepseek`, or `anthropic`     |
| `LLM_MODEL`         | per-provider             | Overrides the provider's default model                      |
| `OPENAI_API_KEY`    | —                        | Required when `LLM_PROVIDER=openai`                         |
| `OPENAI_BASE_URL`   | —                        | Optional: any OpenAI-compatible endpoint (Groq, Mistral, …) |
| `DEEPSEEK_API_KEY`  | —                        | Required when `LLM_PROVIDER=deepseek`                       |
| `ANTHROPIC_API_KEY` | —                        | Required when `LLM_PROVIDER=anthropic`                      |
| `OLLAMA_HOST`       | `http://localhost:11434` | Ollama server URL                                           |
| `OLLAMA_MODEL`      | `gemma4:e2b`             | Ollama model (alias of `LLM_MODEL`, kept for back-compat)   |

Defined in `.env` or inline on the command line.

## Providers

The agent talks to every backend through a small `Provider` interface (`src/providers/`). Two wire formats cover everything:

| Provider         | `LLM_PROVIDER` | Default model               | How it connects                    |
| ---------------- | -------------- | --------------------------- | ---------------------------------- |
| Ollama (default) | `ollama`       | `gemma4:e2b`                | Native `/api/chat`, local, no key  |
| OpenAI           | `openai`       | `gpt-4o-mini`               | `openai` SDK                       |
| DeepSeek         | `deepseek`     | `deepseek-chat`             | `openai` SDK (OpenAI-compatible)   |
| Anthropic        | `anthropic`    | `claude-haiku-4-5-20251001` | `@anthropic-ai/sdk` (Messages API) |

Because the OpenAI adapter is just a `baseURL` + key, **any OpenAI-compatible endpoint** (Groq, Mistral, Together, a local `/v1` server) works by pointing `OPENAI_BASE_URL` at it — no new code. Adding a first-class provider is one entry in the registry in `src/providers/index.ts`.

The agent loop and anti-hallucination guards are provider-agnostic; each adapter only translates the normalized message/tool-call history to and from its provider's wire format.

## Recommended Ollama Models

| Model          | Size   | Quality | Notes                                                                                         |
| -------------- | ------ | ------- | --------------------------------------------------------------------------------------------- |
| **gemma4:e2b** | 7.2 GB | ★★★★★   | **Default.** Native function-calling, built for agentic workflows. Google-recommended params. |
| gemma4:e4b     | 9.6 GB | ★★★★★   | Stronger reasoning, heavier. Same family, better accuracy.                                    |
| qwen3.5:2b     | 2.7 GB | ★★★★☆   | Good budget option. Fast, decent tool use.                                                    |
| llama3.2       | 2.0 GB | ★★☆☆☆   | Works but hallucinates more. Use `OLLAMA_MODEL=llama3.2` to test.                             |

Each model family gets optimal sampling parameters automatically (temperature, top_p, top_k) based on vendor recommendations.

## Project Structure

```
ollama_helper/
├── index.ts                  # Library barrel — exports ask, createAgent, AgentConfig
├── .env                      # Environment variables (OLLAMA_MODEL, OLLAMA_HOST)
├── package.json
├── tsconfig.json
└── src/
    ├── types.ts              # Normalized Message/ToolCall + Provider + Tool interfaces
    ├── providers/
    │   ├── index.ts          # getProvider() — selects the backend from LLM_PROVIDER
    │   ├── ollama.ts         # Native /api/chat adapter + model presets (default)
    │   ├── openai.ts         # OpenAI-compatible adapter (OpenAI, DeepSeek, …)
    │   └── anthropic.ts      # Anthropic Messages API adapter
    ├── tools.ts              # 4 tool definitions (Zod schemas + mock executors)
    └── agent.ts              # Agent loop: ask() + createAgent() factory
```

## API

### `createAgent(config: AgentConfig): (prompt: string) => Promise<string>`

Pre-configure an agent with tools, system prompt, and a prompt wrapper. Returns a single-argument function — call it with any prompt string.

```typescript
import { createAgent } from "ollama_helper";

const ask = createAgent({
  tools: [...],                              // Tool[] — Zod-based tool definitions
  systemPrompt: "You are a helpful agent.",  // System-level instruction to the LLM
  wrap: (p) => `User query:\n> ${p}`,        // Wraps the raw prompt into the user message
});

const answer = await ask("list all contacts grouped by role");
```

### `ask(prompt, tools, systemPrompt, wrap): Promise<string>`

Full-control entry point. Same as `createAgent` but without pre-binding — pass all 4 arguments per call.

```typescript
import { ask } from "ollama_helper";

const answer = await ask(
  "list contacts grouped by role",
  tools,
  "You are a database assistant.",
  (p) => `Query: ${p}`,
);
```

### `AgentConfig`

| Field          | Type                          | Description                                            |
| -------------- | ----------------------------- | ------------------------------------------------------ |
| `tools`        | `Tool[]`                      | Zod-based tool definitions (schema + executor)         |
| `systemPrompt` | `string`                      | System-level instruction sent to the LLM               |
| `wrap`         | `(content: string) => string` | Transforms the user prompt into the final user message |

### `Tool`

```typescript
interface Tool<TSchema extends z.ZodTypeAny> {
  name: string; // Tool name (must match what the LLM calls)
  description: string; // Description sent to the LLM
  schema: TSchema; // Zod schema — auto-converted to JSON Schema
  execute: (args: z.infer<TSchema>) => Promise<unknown>; // Typed executor
}
```

JSON Schema is auto-generated via `z.toJSONSchema(tool.schema)`. The framework automatically strips `null` values from LLM arguments (common with small models) before Zod validation. Use the exported `jsonCoerce` helper for fields that may arrive as stringified JSON arrays/objects.

```typescript
import { z } from "zod";
import { jsonCoerce } from "./src/tools";

const mySchema = z.object({
  columns: jsonCoerce(z.array(z.string())).optional(), // Handles "[\"id\"]" → ["id"]
  filters: jsonCoerce(z.record(z.string(), z.unknown())).optional(),
});
```

## Tools

The agent exposes 4 tools to the LLM. Each is defined as a `Tool` object with a Zod schema and executor:

| Tool              | Description                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `list_entities`   | Search for database tables by keyword or category                                |
| `describe_entity` | Get column metadata, relationships, and data types for a table                   |
| `query_data`      | Execute a query using structured JSON (preferred for all list/aggregate queries) |
| `graphql_execute` | Execute a raw GraphQL query (fallback for complex/nested queries)                |

**`query_data` input format:**

```json
{
  "entity": "contacts",
  "operation": "aggregate",
  "groupBy": ["role"],
  "columns": ["id", "first_name", "last_name"],
  "filters": { "deleted_at": { "is_null": true } },
  "limit": 50
}
```

Filter operators: `eq`, `neq`, `like`, `ilike`, `gt`, `gte`, `lt`, `lte`, `is_null`.

## Anti-Hallucination Measures

The agent employs multiple layers to prevent the LLM from fabricating data:

1. **Zod validation** — All tool arguments validated before execution; invalid args → error fed back to LLM for self-correction
2. **Null stripping** — `null` values for optional fields (common LLM mistake) automatically stripped pre-parse
3. **JSON coercion** — Stringified JSON arrays/objects auto-parsed via `jsonCoerce` helper
4. **Temperature control** — Model-specific presets (e.g., temp 0 for llama3.2 to suppress creativity)
5. **Guard clause** — If the model tries to answer without calling `query_data` or `graphql_execute`, a corrective nudge is injected and the loop retries
6. **Negative constraints** — Prompts explicitly forbid fabrication: _"NEVER fabricate, invent, or guess query results"_

## Mock Tools

When a real Graphoria server is not available, the tools return hardcoded mock data mirroring the capoeira group management schema:

- **5 tables:** contacts, student_profiles, classes, payments, events
- **18 contacts** with roles: 12 students, 1 master, 2 guardians, 3 guests
- **Full column metadata** for the contacts table (11 columns including soft-delete `deleted_at`)

To replace mocks with real server calls, update the executors in `src/tools.ts` to use `fetch()` against the Graphoria REST/GraphQL endpoints.

## Design Decisions

- **`createAgent` factory** — Pre-bind domain config (tools, system prompt, wrap); clean `ask(prompt)` API for callers
- **`ask()` for full control** — 4 positional params when callers need per-call variations
- **Zod schemas for tools** — `z.toJSONSchema()` auto-generates JSON Schema parameters; `z.infer` gives type-safe executor args; no hand-written JSON Schema
- **`stripNulls` applied automatically** — LLMs pass `null` for optional fields; stripped pre-parse so callers write plain Zod schemas
- **`jsonCoerce` opt-in helper** — Small LLMs stringify arrays/objects; opt-in per-field coercion
- **Non-streaming only** (`stream: false`) — simpler loop logic; no need to buffer partial tool_calls across chunks
- **JSON query tool over raw GraphQL** — structured JSON has far fewer syntax failure modes for LLMs than raw GraphQL string construction
- **Max 10 iterations** — safety valve to prevent infinite tool-calling loops
- **Bun runtime** — native fetch, zero-config TypeScript, fast startup

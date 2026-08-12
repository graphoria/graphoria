# AI Agent

> **See also:** [MCP](./MCP.md) | [Permissions](./PERMISSIONS.md) | [Configuration](./CONFIGURATION.md)

Graphoria can run an LLM agent **server-side** that answers natural-language questions about your database. Ask it a question; it discovers the relevant tables, writes and runs read-only GraphQL queries against your schema, and returns a written answer. It is exposed two ways: a GraphQL `ask` query and a REST `POST` endpoint.

The agent reuses the same tooling as the [MCP server](./MCP.md) (`list_entities`, `describe_entity`, `graphql_execute`) from `ai/tools/core.ts` but drives the tool-calling loop _inside_ the server instead of handing tools to an external client.

The integration is **opt-in**, **admin-only**, and **read-only**: only callers presenting the admin secret reach it, mutations/subscriptions are rejected, and the agent runs against the full (`superadmin`) schema.

## Enabling the agent

Off by default. Turn it on in your configuration file:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    /* … */
  ],
  ai: {
    enabled: true,
    // endpoint: "/ai",          // REST path (default "/ai")
    // systemPrompt: "…",        // override the built-in prompt
  },
})) satisfies ConfigurationFn;
```

## Choosing an LLM provider

The provider, model, and credentials come from **environment variables**, not the config file. The default is [Ollama](https://ollama.com) (local, no API key). Switch providers with `LLM_PROVIDER`:

| Variable             | Default                  | Description                                                     |
| -------------------- | ------------------------ | --------------------------------------------------------------- |
| `LLM_PROVIDER`       | `ollama`                 | `ollama`, `openai`, `deepseek`, or `anthropic`                  |
| `LLM_MODEL`          | per-provider             | Overrides the provider's default model                          |
| `OPENAI_API_KEY`     | —                        | Required when `LLM_PROVIDER=openai`                             |
| `OPENAI_BASE_URL`    | —                        | Any OpenAI-compatible endpoint (Groq, Mistral, …)               |
| `DEEPSEEK_API_KEY`   | —                        | Required when `LLM_PROVIDER=deepseek`                           |
| `ANTHROPIC_API_KEY`  | —                        | Required when `LLM_PROVIDER=anthropic`                          |
| `OLLAMA_HOST`        | `http://localhost:11434` | Ollama server URL                                               |
| `AI_SYSTEM_PROMPT`   | —                        | Overrides the built-in system prompt sent to the LLM            |
| `AI_PROMPT_TEMPLATE` | —                        | Overrides the user-message wrapper (use `{prompt}` placeholder) |

The `openai` and `@anthropic-ai/sdk` packages are **optional dependencies** — they load lazily only when their provider is selected. With the default Ollama provider, neither is needed.

## Endpoints

Both require the admin secret (`x-admin-secret` header by default). Without it, the REST route returns `404` and the GraphQL field is absent from the schema.

### REST

| Verb | Path  | Body                                          | Response            |
| ---- | ----- | --------------------------------------------- | ------------------- |
| POST | `/ai` | `{ "prompt": "how many orders per status?" }` | `{ "answer": "…" }` |

```bash
curl -X POST http://localhost:3000/ai \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"prompt":"how many orders per status?"}'
```

The path is configurable via `ai.endpoint`. The full URL is `${PREFIX}${endpoint}`.

### GraphQL

A single root **query** field, present only in the admin (`superadmin`) schema:

```graphql
query {
  ask(prompt: "how many orders per status?")
}
```

Send it to `/graphql` with the admin secret header. Returns the answer as a `String`.

## How it works

1. The agent is built once at boot, bound to the `superadmin` role's compiled schema.
2. Each call runs a tool-calling loop (max 10 iterations): `list_entities` → `describe_entity` → `graphql_execute`.
3. Anti-hallucination guards reject answers that never queried the data and forbid fabrication.
4. The final text answer is returned; intermediate tool calls are hidden from the caller.

Because the agent always runs as `superadmin`, it can read everything. Do not enable it on deployments where admin-secret holders should not see all data.

## Limitations

- **Database questions only.** The agent loop guards against fabrication by requiring at least one `graphql_execute` call before it accepts a final answer. A prompt that needs no data (e.g. "hello") is nudged to query and, finding nothing to query, eventually errors after the iteration cap. Treat this as a data Q&A endpoint, not a general chatbot.
- **Runs as `superadmin`.** The agent sees the entire schema regardless of who calls it. Anyone holding the admin secret can read everything through it.
- **Read-only.** Mutations and subscriptions are rejected at the tool boundary.
- **Iteration cap.** The tool-calling loop is bounded (10 iterations); a question that can't be answered within that budget errors rather than looping forever.

## Customizing the prompt

Three layers, highest priority first:

| Layer            | Key                      | What it controls                                           |
| ---------------- | ------------------------ | ---------------------------------------------------------- |
| Env var          | `AI_SYSTEM_PROMPT`       | Full system prompt override                                |
| Env var          | `AI_PROMPT_TEMPLATE`     | User-message wrapper template (use `{prompt}` placeholder) |
| Config file      | `ai.systemPrompt`        | Full system prompt override (no template from config)      |
| Built-in default | (see `singletons/ai.ts`) | Discovery workflow + aggregate rules + anti-fabrication    |

`AI_SYSTEM_PROMPT` replaces the built-in system prompt entirely. `AI_PROMPT_TEMPLATE` replaces the wrapper that surrounds the user's raw question before it's sent to the LLM — use `{prompt}` where the user's input should go. The default template includes step-by-step workflow instructions; override it if your LLM provider has different conventions.

The config-file `ai.systemPrompt` field takes effect only when `AI_SYSTEM_PROMPT` is not set.

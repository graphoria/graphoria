# AI Agent

> **See also:** [MCP](./MCP.md) | [Permissions](./PERMISSIONS.md) | [Configuration](./CONFIGURATION.md)

Graphoria can run an LLM agent **server-side** that answers natural-language questions about your database. Ask it a question; it discovers the relevant tables, writes and runs read-only GraphQL queries against your schema, and returns a written answer. It is exposed two ways: a GraphQL `ask` query and a REST `POST` endpoint.

The agent reuses the same tooling as the [MCP server](./MCP.md) — `list_entities`, `describe_entity`, `query_data`, `graphql_execute`, sharing the executors in `ai/tools/core.ts` — but drives the tool-calling loop _inside_ the server instead of handing tools to an external client. It is four of the six MCP tools: `graphql_validate` and `rest_execute` are not offered to the agent, and none of the four can be disabled the way the MCP ones can.

The integration is **opt-in**, **role-scoped**, and **read-only**. A role granted `ai` ([Permissions](./PERMISSIONS.md)) calls it with its own token, and the agent reads exactly what that role reads: its tables and columns, its row filters evaluated with the caller's session. The superadmin role — the admin secret — is always granted. Mutations and subscriptions are rejected.

## Enabling the agent

Off by default. Turn it on in your configuration file:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [/* … */],
  ai: {
    enabled: true,
    // endpoint: "/ai",          // REST path under REST_API_PREFIX (default /rest/ai)
    // systemPrompt: "…",        // override the built-in prompt
  },
})) satisfies ConfigurationFn;
```

`AI_ENABLED` overrides `ai.enabled` when set; the override is logged at boot.

## Choosing an LLM provider

The provider, model, and credentials come from **environment variables**, not the config file. The default is [Ollama](https://ollama.com) (local, no API key). Switch providers with `LLM_PROVIDER`:

| Variable             | Default                  | Description                                                                                                                                                                        |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`       | `ollama`                 | `ollama`, `openai`, `deepseek`, or `anthropic`                                                                                                                                     |
| `LLM_MODEL`          | per-provider             | Overrides the provider's default model                                                                                                                                             |
| `OPENAI_API_KEY`     | —                        | Required when `LLM_PROVIDER=openai`                                                                                                                                                |
| `OPENAI_BASE_URL`    | —                        | Any OpenAI-compatible endpoint (Groq, Mistral, …)                                                                                                                                  |
| `DEEPSEEK_API_KEY`   | —                        | Required when `LLM_PROVIDER=deepseek`                                                                                                                                              |
| `ANTHROPIC_API_KEY`  | —                        | Required when `LLM_PROVIDER=anthropic`                                                                                                                                             |
| `OLLAMA_HOST`        | `http://localhost:11434` | Ollama server URL                                                                                                                                                                  |
| `AI_SYSTEM_PROMPT`   | —                        | Overrides the built-in system prompt sent to the LLM                                                                                                                               |
| `AI_PROMPT_TEMPLATE` | —                        | Overrides the user-message wrapper (use `{prompt}` placeholder)                                                                                                                    |
| `AI_ENABLED`         | (config field)           | Turns the agent on or off over `ai.enabled`                                                                                                                                        |
| `AI_GRAPHQL_ENABLED` | `true`                   | `false` leaves the GraphQL `ask` field out of every schema                                                                                                                         |
| `AI_REST_ENABLED`    | `true`                   | `false` leaves the REST route unmounted                                                                                                                                            |
| `AI_SECRET_ROLE`     | `SUPERADMIN_ROLE`        | The role `AI_SECRET` reads as; must be granted `ai` (checked at boot). Its session is `sub: "ai"` with no claims, so a `$session` row filter on that role matches nothing or fails |

The `openai` and `@anthropic-ai/sdk` packages are **optional dependencies** — they load lazily only when their provider is selected. With the default Ollama provider, neither is needed.

## Endpoints

Both resolve the caller like `/graphql`: `Authorization: Bearer <token>` for the token's role, the admin secret (`x-admin-secret` by default) for the superadmin role. The REST route also accepts `AI_SECRET` in the admin-secret header: a credential scoped to the agent alone, a comma-separated list rotated like `ADMIN_SECRET`, unset by default. It reads as `AI_SECRET_ROLE` (default the superadmin role) and opens nothing else — sent to `/graphql`, `/rest/*` or `/mcp` it resolves to the anonymous role, so the GraphQL `ask` field stays out of its reach. The admin secret logs a warning each time it is used on the REST route, where the scoped credential would have done.

A role without `ai` gets `404` from the REST route, and the `ask` field is absent from its schema.

### REST

| Verb | Path       | Body                                          | Response            |
| ---- | ---------- | --------------------------------------------- | ------------------- |
| POST | `/rest/ai` | `{ "prompt": "how many orders per status?" }` | `{ "answer": "…" }` |

```bash
curl -X POST http://localhost:3000/rest/ai \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"prompt":"how many orders per status?"}'
```

The path is configurable via `ai.endpoint`, under the REST prefix: the full URL is `${PREFIX}${REST_API_PREFIX}${endpoint}` (default `/rest/ai`). Setting `AI_REST_ENABLED=false` leaves the route unmounted, so the agent is reachable through the GraphQL `ask` field only. `AI_GRAPHQL_ENABLED=false` leaves the `ask` field out of every schema, so the agent is reachable over REST only.

### GraphQL

A single root **query** field, compiled into the schema of every role granted `ai`:

```graphql
query Ask($prompt: String!) {
  ask(prompt: $prompt)
}
```

Send it to `/graphql` with the caller's token (or the admin secret), passing the prompt inline or as a variable. Returns the answer as a `String`.

## How it works

1. At boot the agent stores its prompts. Each call builds its tools for the caller's role, session and request.
2. Each call runs a tool-calling loop (max 10 iterations): `list_entities` → `describe_entity` → `query_data`. The built-in prompt steers the agent to `query_data`, whose structured JSON input the server turns into GraphQL; `graphql_execute` remains available for queries that shape cannot express.
3. Anti-hallucination guards reject answers that never queried the data and forbid fabrication.
4. The final text answer is returned; intermediate tool calls are hidden from the caller.

The agent reads through the caller's role, so a prompt cannot reach a table, column or row the caller's own queries could not. What it reads is sent to the LLM provider.

## Limitations

- **Database questions only.** The agent loop guards against fabrication by requiring at least one `query_data` or `graphql_execute` call before it accepts a final answer. A prompt that needs no data (e.g. "hello") is nudged to query and, finding nothing to query, eventually errors after the iteration cap. Treat this as a data Q&A endpoint, not a general chatbot.
- **Reads as the caller.** A role's row filters apply with the caller's session; the admin secret reads everything.
- **Read-only.** Mutations and subscriptions are rejected at the tool boundary.
- **No `ask` inside a tool.** A tool query that selects `ask` is refused, so the agent cannot start itself again.
- **An inline prompt starting with `$` is read as a variable.** `ask(prompt: "$total")` fails with `Variable total not found`; pass such a prompt as a variable.
- **Iteration cap.** The tool-calling loop is bounded (10 iterations); a question that can't be answered within that budget errors rather than looping forever.
- **Prompts are audit-logged.** Every invocation writes an `ai.ask` record carrying the prompt verbatim — see [Audit log](../README.md#audit-log). Do not put secrets in a prompt.

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

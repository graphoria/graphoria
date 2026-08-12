# Model Context Protocol (MCP)

> **See also:** [Permissions](./PERMISSIONS.md) | [Operations](./OPERATIONS.md) | [Configuration](./CONFIGURATION.md)

Graphoria can expose its GraphQL and REST surface to LLM agents over the [Model Context Protocol](https://modelcontextprotocol.io). When enabled, the server mounts a `/mcp` endpoint that speaks JSON-RPC over the streamable HTTP transport. Clients like Claude Desktop, MCP Inspector, or your own agent can discover the schema, run read-only GraphQL queries, and call REST routes — all through the standard MCP tool/resource model.

The integration is **opt-in**, **anonymous-only**, and **read-only** by design: mutations and subscriptions are rejected at the boundary, and every tool runs against the schema your `anonymous` role would normally see.

## Enabling MCP

Off by default. Flip it on either in your config file or via an environment variable.

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    /* … */
  ],
  ai: {
    mcp: {
      enabled: true,
    },
  },
})) satisfies ConfigurationFn;
```

Equivalently, without touching the configuration:

```bash
AI_MCP_ENABLED=true bun run start
```

The env variable wins over the config field; an override is logged at boot.

## Endpoint

| Verb   | Path   | Notes                                                         |
| ------ | ------ | ------------------------------------------------------------- |
| POST   | `/mcp` | JSON-RPC requests (the only verb the protocol actually uses). |
| GET    | `/mcp` | Always returns `405`. Stateless transport — no SSE upgrade.   |
| DELETE | `/mcp` | Always returns `405`.                                         |

The path is configurable via `AI_MCP_ENDPOINT` (default `/mcp`). The full URL is `${PREFIX}${AI_MCP_ENDPOINT}`.

Connect from Claude Desktop or another client by adding a server entry that points at `http(s)://your-host/mcp`.

## Tools

Five tools are registered by default:

| Tool               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `graphql_execute`  | Runs a GraphQL **query** against the anonymous-role schema. Mutations and subscriptions are rejected. Returns `{ data, errors }`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `graphql_validate` | Validates a query without executing it. Cheap, no DB hit. Useful for the agent to iterate on syntax before paying the round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `list_entities`    | Lists everything visible to the anonymous role: tables, operations, remote schemas, remote REST APIs, stored procedures, queue publishers. **Requires at least one of `kind` or `search`** — calls with no arguments are rejected so the agent stays focused. `search` is a case-insensitive substring match against the entity name _and_ its description (for tables, this includes `tableDescription`; for operations, the operation `description`), so natural-language keywords still find cryptically-named tables.                              |
| `describe_entity`  | Returns details about a single entity. For tables: columns (each with its `description`, sourced from the database or a config override), both directions of relationships, the generated list-field signature, the `_aggregate` field signature, and a small `examples` block with ready-to-run `list` / `filter` / `aggregate` queries built from this table's real column names (the aggregate example demonstrates the `key { … }` sub-selection that trips up Hasura-trained agents). For remote schemas/REST: the imported SDL or OpenAPI shape. |
| `rest_execute`     | Calls the anonymous-role REST handler. `path` is relative to the REST prefix; `body` is auto-JSON-stringified. Returns `{ status, headers, body }`.                                                                                                                                                                                                                                                                                                                                                                                                    |

### Why these tools

LLM agents do better with a small surface that mirrors how a human explores the API: list, describe, validate, run. The tools above are designed to be self-explanatory from their schemas alone, so the agent rarely needs out-of-band documentation.

## Resources

Three static resources are exposed:

| URI                       | MIME               | Contents                                                                             |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `graphql://schema`        | `text/plain`       | Anonymous-role schema, in SDL.                                                       |
| `graphql://introspection` | `application/json` | Anonymous-role introspection result (the same JSON Apollo / GraphiQL would request). |
| `openapi://spec`          | `application/json` | Unified OpenAPI document (operations + remote-REST).                                 |

Resources are stateless — clients fetch them on demand.

## Prompts

One prompt is registered by default. Clients that implement the MCP prompts capability surface it as a namespaced slash command — in Claude Code, for example, that is `/mcp__<server-name>__db_query` (the server name comes from your `configuration.name`, defaulting to `graphoria-mcp-server`).

| Name       | Args               | Purpose                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db_query` | `question: string` | Injects a user-role message containing the question plus a workflow reminder (`list_entities` → `describe_entity` → `graphql_execute`) and the Graphoria aggregate-syntax rules. Use when you want the agent primed to query the database the right way without depending on `instructions` having stayed in context. |

### Why a prompt at all

The server already ships a long `instructions` cheat sheet on `initialize`. Clients are free to summarize, truncate, or drop it as the conversation grows. A prompt is the durable channel: invoking it re-injects the rules at exactly the moment the agent needs them, attached to the user's actual question.

### Server-side guidance baked in

The `db_query` callback embeds, in addition to the question:

- The discovery workflow and the order to run it in.
- A reminder that `list_entities` needs `kind` or `search`, and that `search` is fuzzy across descriptions.
- A directive to read `examples.list / examples.filter / examples.aggregate` from `describe_entity` rather than composing aggregate queries from scratch.
- The Graphoria aggregate shape (`<entity>_aggregate(groupBy: […]) { key { … } count items { … } }`) with the explicit "`key` is an object — must be sub-selected" rule.
- An anti-pattern callout for Hasura-style `{ aggregate { count } }` nesting and for client-side counting.
- A request to render grouped results as a Markdown table.

### Disabling

Same shape as tools and resources — comma-separated names in `AI_MCP_DISABLED_PROMPTS` (see the env table below).

## Environment variables

All MCP env knobs are optional. They override config-driven settings when present.

| Variable                      | Type      | Default                           | Effect                                                                                                                         |
| ----------------------------- | --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AI_MCP_ENABLED`              | `boolean` | (config field)                    | Force on/off without editing the config. Logged when overriding.                                                               |
| `AI_MCP_ENDPOINT`             | `string`  | `/mcp`                            | Path under `PREFIX` to mount the route.                                                                                        |
| `AI_MCP_REQUIRE_ADMIN_SECRET` | `boolean` | `false`                           | When true, every POST `/mcp` request must carry a matching admin-secret header (timing-safe compare). 401 otherwise.           |
| `AI_MCP_MAX_QUERY_DEPTH`      | `number`  | (falls back to `MAX_QUERY_DEPTH`) | MCP-specific depth cap. `0` means no limit.                                                                                    |
| `AI_MCP_DISABLED_TOOLS`       | `string`  | `""`                              | Comma-separated tool names to skip registration. Example: `AI_MCP_DISABLED_TOOLS=rest_execute,describe_entity`.                |
| `AI_MCP_DISABLED_RESOURCES`   | `string`  | `""`                              | Comma-separated resource URIs **or** names to skip. Example: `AI_MCP_DISABLED_RESOURCES=openapi://spec,graphql-introspection`. |
| `AI_MCP_DISABLED_PROMPTS`     | `string`  | `""`                              | Comma-separated prompt names to skip registration. Example: `AI_MCP_DISABLED_PROMPTS=db_query`.                                |
| `AI_MCP_GRAPHQL_ENABLED`      | `boolean` | `true`                            | When `false`, the `graphql_execute` tool is not registered. Use to expose a read-only REST MCP surface.                        |
| `AI_MCP_REST_ENABLED`         | `boolean` | `true`                            | When `false`, the `rest_execute` tool is not registered. Use to expose a read-only GraphQL MCP surface.                        |

The admin-secret header name comes from `ADMIN_SECRET_HEADER` (default `x-admin-secret`); the value is whatever you set `ADMIN_SECRET` to. Both must be present for the gate to pass.

## Permissions and safety

- **Anonymous-role only.** Tools always run as `anonymous`. There is no per-call role argument and no token verification. If `anonymous` does not have access to a table, it does not appear in `list_entities` and `graphql_execute` cannot return rows from it.
- **Mutations are blocked.** `graphql_execute` parses the document and rejects any `mutation` or `subscription` operation before validation runs. Use the GraphQL endpoint directly with a real bearer token if you need writes.
- **REST execute uses the same handler stack as `/rest/*`.** Anything an unauthenticated client could hit at `/rest` is reachable via `rest_execute` — and only that.
- **Constant-time secret check.** When `AI_MCP_REQUIRE_ADMIN_SECRET=true`, the header compare uses `crypto.timingSafeEqual`. A missing or empty `ADMIN_SECRET` always fails the gate.
- **No rate limiting.** The endpoint inherits whatever you have at the proxy or load-balancer layer. Treat `/mcp` like `/graphql` — public, but expensive enough to deserve a WAF rule if it's exposed to the internet.

## Client-side example

Claude Desktop's `mcp_servers.json`:

```json
{
  "mcpServers": {
    "graphoria": {
      "transport": {
        "type": "streamable-http",
        "url": "https://api.example.com/mcp",
        "headers": {
          "x-admin-secret": "${env:GRAPHORIA_ADMIN_SECRET}"
        }
      }
    }
  }
}
```

The `headers` block is only needed when `AI_MCP_REQUIRE_ADMIN_SECRET=true`. Use the variable name you configured via `ADMIN_SECRET_HEADER` if you changed the default.

## Local exploration

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the easiest way to poke at the surface during development:

```bash
npx @modelcontextprotocol/inspector
# point it at http://localhost:3000/mcp
```

The inspector lists every registered tool and resource, lets you call them with arbitrary JSON arguments, and shows the raw responses. The same protocol your LLM agent will speak — without the LLM in the loop.

## Tips and gotchas

- **Stateless transport.** Each POST is an independent JSON-RPC interaction. There is no MCP "session"; client config is the only place you put per-connection state (such as the admin-secret header).
- **`describe_entity` is schema-driven.** The output for tables is built from the real compiled `GraphQLSchema`, so adding a virtual column or directive shows up immediately on next request — no MCP-side rebuild needed.
- **Disabling tools and resources is one-way.** A disabled tool is _not registered_ — clients that probe via `tools/list` will simply not see it. Re-enable by removing the entry from `AI_MCP_DISABLED_TOOLS` and restarting.
- **Mutations via REST.** `rest_execute` does _not_ enforce the "queries only" rule that `graphql_execute` does — anonymous-role REST operations can still write if your operations expose them. If you want a strictly read-only MCP surface, gate writes via permissions, or disable `rest_execute` outright.
- **The server name and version come from your config.** `configuration.name` and `configuration.version` are passed straight through to the MCP client as the server identity. Bump the version when you make breaking changes to your operations or schema.
- **Subscriptions are not on the menu.** The streamable HTTP transport is stateless; long-lived subscriptions would need session support. For now, agents can poll via `graphql_execute` if they want change feeds.

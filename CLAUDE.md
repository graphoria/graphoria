## Rule 1 — Think Before Coding

State assumptions explicitly. If uncertain, ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

## Rule 2 — Simplicity First

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.

## Rule 3 — Surgical Changes

Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting. Match existing style.

## Rule 4 — Goal-Driven Execution

Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate independently.

## Rule 5 — Token budgets are not advisory

Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh. Surface the breach.

## Rule 6 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.

If unsure why code is structured a certain way, ask.

## Rule 7 — Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back. Stop and restate.

## Rule 8 — Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

# CLAUDE.md - Graphoria Agent Guide

Single-page orientation for AI assistants working in this repo. **User-facing docs live in [docs/](./docs/) and per-package READMEs — do not duplicate them here.** Keep this file dense; every line should be either a pointer or a fact you can't easily grep.

---

## What this is

Graphoria is a Bun + TypeScript monorepo (workspace, not a single package). It auto-generates GraphQL and REST APIs from database schemas and adds auth, queues, cron, remote-schema stitching, and remote-REST proxying on top. Three workspace packages: `@graphoria/server` (runtime + config-authoring surface at `@graphoria/server/config`), `@graphoria/react` (frontend SDK), plus one private playgrounds Vite project (two apps) that builds the static HTML the server serves at `/graphiql` and `/scalar`.

| Package                  | Path                    | Imports                                              | Notes                                                                                                                                                                                                        |
| ------------------------ | ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@graphoria/server`      | `packages/server/`      | `zod` + lots                                         | The actual server. Where 95 % of changes land.                                                                                                                                                               |
| `@graphoria/react`       | `packages/react/`       | `react`, `@apollo/client`                            | Hooks, providers, Apollo client. Small surface.                                                                                                                                                              |
| `@graphoria/playgrounds` | `packages/playgrounds/` | `react`, `graphiql`, `@scalar/api-reference`, `vite` | Private. One Vite project, two apps (`graphiql/`, `scalar/`) selected via `--mode`; single-file builds → `packages/server/playgrounds/{graphiql,scalar}/index.html` via server's `build:playgrounds` script. |

Config-authoring types + helpers live in `packages/server/src/config/` (exposed as `@graphoria/server/config`); `src/types/` extends them with runtime concerns (e.g. `OperationOptions` with `BunRequest`).

---

## Where things live

`packages/server/src/` (everything important is under here):

| Concern                                                         | Path                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server entry points                                             | `index.ts` — `createGraphQLServer`, `createHandlers`, `createBunServer`                                                                           |
| Configuration loader & analyzer                                 | `configuration/index.ts` — `loadConfiguration`, `analyzeConfiguration`                                                                            |
| GraphQL request handling                                        | `configuration/gql/handleGraphQLRequestFactory.ts`                                                                                                |
| GraphQL subscriptions (websocket)                               | `configuration/gql/handleGraphQLSubscriptionFactory.ts`                                                                                           |
| REST request handling                                           | `configuration/rest/handleRESTRequestFactory.ts`                                                                                                  |
| Operation hooks orchestration (init/beforeRequest/afterRequest) | inline in `configuration/rest/handleRESTRequestFactory.ts`                                                                                        |
| Query parsing                                                   | `analyzeQuery/index.ts` + `analyzers/`                                                                                                            |
| Database query building (shared)                                | `databases/common.ts` (`buildWhereClauseFp`, `buildOrderByClauseFp`, etc.)                                                                        |
| Engine-specific code                                            | `databases/engines/{postgresql,mssql,mysql}/`                                                                                                     |
| Schema introspection                                            | `databases/engines/*/getStructure.ts`                                                                                                             |
| Auth tables creation + login                                    | `databases/engines/*/auth.ts`                                                                                                                     |
| Identifier safety helper                                        | `databases/core/identifier.ts` — `assertSafeIdentifier`                                                                                           |
| Auth password hashing                                           | `databases/auth/password.ts` — `hashPassword`, `verifyPassword` (Bun argon2id)                                                                    |
| Token services                                                  | `authentication/index.ts` (dispatcher), `jwt.ts`, `paseto.ts`                                                                                     |
| Token revocation / replay store                                 | `authentication/tokenRepository.ts` (Redis hash per JTI)                                                                                          |
| Data-transform directives                                       | `databases/directives.ts` — `DIRECTIVE_HANDLERS`                                                                                                  |
| `@when` control-flow directive                                  | `databases/common.ts` (search `whenDirective`) + `analyzeQuery/analyzers/selectionAnalyzer.ts`                                                    |
| Singletons (mutable globals)                                    | `singletons/{databases,authentication,cron,queues,env,cache}.ts`                                                                                  |
| RabbitMQ / Kafka runtime                                        | `queues/rabbitmq.ts`, `queues/kafka.ts`                                                                                                           |
| Cron runtime                                                    | `cron/`, `singletons/cron.ts`                                                                                                                     |
| Remote GraphQL schemas                                          | `remoteSchemas/{introspect,transform,proxy,index}.ts`                                                                                             |
| Remote REST APIs                                                | `remoteREST/{parse,transform,proxy,index}.ts`                                                                                                     |
| AI / MCP / tools umbrella                                       | `ai/` — see sub-folders below                                                                                                                     |
| AI agent (LLM tool-calling loop)                                | `ai/agent/{agent,index,types}.ts` + `ai/agent/providers/` ; singleton `singletons/ai.ts`; field wired in `handleGraphQLRequestFactory.ts` (`ask`) |
| MCP server (tools + resources)                                  | `ai/mcp/{create-server,index}.ts`                                                                                                                 |
| AI/MCP shared tool executors                                    | `ai/tools/core.ts` (`list_entities`/`describe_entity`/`graphql_execute` core, role-bound)                                                         |
| Zod schemas (config validation)                                 | `types/zod/configuration.ts` + per-feature files                                                                                                  |
| Env loader                                                      | `types/env.ts` (`EnvZod`)                                                                                                                         |
| Test fixtures                                                   | `__test/fixtures/`, `__test/dbMocks.ts`, `__test/dataset/`                                                                                        |
| Generated per-role schemas (build artefact)                     | `__schemas/`                                                                                                                                      |

`src/config/types/` holds the config shape: `configuration.ts`, `operation.ts`, `cron.ts`, `virtual-columns.ts` (public via `@graphoria/server/config`).

---

## Conventions you can't grep for

- **`Fp` suffix** = curried factory. `buildWhereClauseFp("pg")` returns the PG-specialized variant. The non-suffixed export (`buildWhereClausePG`) is just `buildWhereClauseFp("pg")` evaluated. When adding a database-aware helper, follow the same pattern.
- **Files**: `camelCase.ts` or `kebab-case.ts`. Tests adjacent to source as `*.test.ts`. Tests live in `bun:test` (`import { describe, it, expect } from "bun:test"`).
- **Types**: `PascalCase`. Functions: `camelCase`. Constants: `SCREAMING_SNAKE_CASE` for compile-time, `camelCase` for runtime.
- **Imports**: ordered `react → third-party → types → local`. Run `bun run format` (oxfmt) to apply. Don't hand-sort.
- **Strict TypeScript**. Avoid `any`; if forced, comment why. `as unknown as X` is a yellow flag — usually means a real type contract is being papered over.
- **Comments policy**: write none by default. Only when WHY is non-obvious — invariants, hidden constraints, workarounds. Don't restate WHAT.
- **Comparisons of secrets**: always `crypto.timingSafeEqual` (see `safeCompare` in `jwt.ts` / `paseto.ts`).
- **Configuration files** (`graphoria.ts`) are TypeScript modules whose default export is a _function_ `(helpers) => ConfigurationInput`. They're loaded via dynamic `import()` and validated against `ConfigurationZod` at startup.

---

## Architecture, in 60 seconds

**Boot path**: `createBunServer` → `createHandlers` → `createGraphQLServer` → `loadConfiguration` (dynamic import + `ConfigurationZod.parse`) → `instantiateDatabasesConnections` → `setTokenService` → `analyzeConfiguration` (per-role schema build, remote schema/REST resolution, route registration) → `instantiateQueues` → `instantiateCronJobs` → assemble routes map → return `{ websocketHandler, routes, prefixes }`.

**Patterns**:

- **Factories** with closed-over deps. Most handlers are produced by a `xFactory(entities, gqlEntities, auth?)` call during config analysis — the closure is the request-time handler.
- **Singletons** for cross-cutting state. Each `singletons/*.ts` exposes get/set; the `instantiate*` functions populate them at boot.
- **Per-role schema entities**. RBAC is enforced by _building a different `MergedEntities` per role_ — query handlers don't re-check permissions, the schema they receive simply lacks anything the role can't see.
- **Token strategies** dispatched in `authentication/index.ts`. Selected via `tokenStrategy` config field (`"jwt"` default, `"paseto_local"`, `"paseto_public"`); each strategy validates its own required env vars.
- **Subscriptions are queue-driven**. Every `subscribers` entry under a queue config becomes a GraphQL subscription field. There's no built-in way to drive subscriptions from query results.

---

## Common task playbooks

### Add a new database engine

1. New folder `databases/engines/{engine}/` with `connection.ts`, `auth.ts`, `format.ts`, `getStructure.ts`, `getViews.ts`, `query/index.ts`.
2. Wire it into `databases/core/function-mapping.ts` (the dispatcher all callers go through).
3. Add type mapping in `configuration/getSchemas/type-definition-generator/`.
4. Connection handling in `singletons/databases.ts`.

### Add a data-transform directive

1. Add a handler entry to `DIRECTIVE_HANDLERS` in `databases/directives.ts`. Return the SQL fragment given the `querySelector`, `directive.arguments`, and `dbType`.
2. Add tests in `databases/directives.test.ts` — there's a row per directive there already.
3. The directive is auto-applied in `applyDirectives` (left-to-right chaining); no schema definition file needs editing because directives are accepted permissively in queries.

### Add a `ConfigurationInput` field

1. Type it in `packages/server/src/config/types/configuration.ts`.
2. Add a Zod schema in `packages/server/src/types/zod/` and reference it from `configuration.ts` Zod.
3. If it has runtime behavior, add an instantiator in `singletons/` and wire it into the boot path in `index.ts` or `configuration/index.ts`.

### Add a custom permission key

RBAC permission keys live on `RolePermission` in `packages/server/src/config/types/configuration.ts`. The actual filtering happens in `configuration/index.ts` → `sourcesForEachRole` (in `high-level-operations.ts`). Add the key, update the type, and decide which entity collection it filters.

### Add a new operation hook

Hooks (`init`, `beforeRequest`, `afterRequest`) are wired inline in `configuration/rest/handleRESTRequestFactory.ts`. To add one, extend `BaseOperation.hooks` in `packages/server/src/config/types/operation.ts`, then call it at the right moment in the factory. `init` is cached per route (lifetime of the process); `beforeRequest` runs per-request before the handler/query; `afterRequest` runs only on custom-handler routes after the handler returns.

### Test code that needs Redis / a DB / a broker

**Inject a fake at the boundary, do not mock the module.** See `authentication/tokenRepository.test.ts` for the pattern: the factory accepts a typed client interface, production uses Bun's RedisClient, tests pass a `Map`-backed fake. Mirror this whenever a unit needs an external dependency.

---

## Gotchas (things that have already bitten us)

- **SQL identifier interpolation**: schema/table names that come from config still get interpolated into raw SQL in places (`databases/engines/*/auth.ts`, schema creation, table inspection). Always wrap them with `assertSafeIdentifier(name, "schema")` from `databases/core/identifier.ts`. Never assume zod validates them — it doesn't enforce SQL-safe identifier shape.
- **PG / MySQL parameterized queries**: `pool.unsafe(query, paramsArray)` with `$1, $2, …` placeholders. The function name is misleading — the params _are_ bound; only string interpolation in the query text is unsafe.
- **MSSQL parameterized queries**: `pool.request().input(name, type, value).query(text)` with `@name` placeholders. Types come from `import { NVarChar, Int, … } from "mssql"`.
- **`tokenRepository`**: `saveJti` and `revoke` write to the same Redis hash. `saveJti` sets `isUsed=true` + TTL; `revoke` only sets `isRevoked=true` and _must not_ extend or replace the TTL. Don't `client.del(jti)` — that loses the audit trail.
- **`@when` directive lives in `databases/common.ts`**, not `databases/directives.ts`. The latter is data-transform only; control-flow directives are processed in `shouldIncludeField`.
- **Queue config has two shapes**. The user-facing config in `src/config/` uses `publishers` / `subscribers` / `topics` records. The Zod transform in `types/zod/queue.ts` pivots that into internal `exchanges` / `queues` arrays that the runtime in `queues/rabbitmq.ts` consumes. When debugging queues, remember which view you're looking at.
- **Subscription auth is captured once**. `connection_init` carries the JWT/PASETO; the resulting session is stored in `subscriptionMapping` for the lifetime of the WebSocket. Token rotation requires the client to reconnect.
- **Configuration is re-imported at startup, not watched**. Editing `graphoria.ts` while the dev server runs needs a restart unless you're using `bun --watch`.
- **`bun run type-check`** runs `tsc --noEmit` in each package via `bun run --filter '*' type-check`. Don't run `tsc` from the root — it sees the whole tree as one project.
- **Per-role schemas**: every role gets its own compiled `GraphQLSchema`. A field missing for one role might exist for another. When debugging "field not found" errors, check `analyzedConfiguration.roles[<role>].schema`.
- **Auth tables are auto-created** on every boot when `auth.enabled`. The `userTableCreation` SQL is idempotent (`IF NOT EXISTS`) but still runs. There's no built-in seed flow — users have to insert manually.
- **`@cfworker/json-schema` is required even though nothing here imports it.** `@modelcontextprotocol/server` lists it as an _optional_ peer (`peerDependenciesMeta.optional = true`), but its compiled `dist/*.mjs` still does a static `import` of it for JSON-schema validation of tool inputs. When the package is absent from `node_modules`, importing `@graphoria/server` blows up at module-load with `Cannot find module '@cfworker/json-schema'`. Keep it in `dependencies` even if `grep` shows no usage in our `src/`.

---

## Testing

- Bun's runner: `import { describe, it, expect, beforeAll, beforeEach } from "bun:test"`.
- Unit tests are adjacent to source. Integration-ish tests use the fixtures and mocks under `__test/`.
- Run all: `bun test`. Single file: `bun test path/to/file.test.ts`. Filter by name: `bun test -t "pattern"`.
- Adding a feature without a test is a smell.
- Key test files worth reading before extending: `analyzeQuery/index.test.ts`, `databases/directives.test.ts`, `databases/common.test.ts`, `databases/engines/*/query/index.test.ts`, `databases/high-level-operations.test.ts`, `authentication/{jwt,paseto,tokenRepository}.test.ts`, `configuration/rest/handleRESTRequestFactory.test.ts`, `utils/sessionVariables.test.ts`, `remoteSchemas/*.test.ts`, `remoteREST/*.test.ts`.

---

## Dev commands

| Command                  | What it does                                  |
| ------------------------ | --------------------------------------------- |
| `bun run dev`            | Hot-reload dev server. Uses `./graphoria.ts`. |
| `bun run start`          | Production start (no reload).                 |
| `bun run cluster`        | Cluster-mode start.                           |
| `bun run build`          | Compile each package to `dist/`.              |
| `bun run type-check`     | `tsc --noEmit` across all packages.           |
| `bun run lint`           | `oxlint` over source.                         |
| `bun test`               | Full test suite.                              |
| `bun run prepublishOnly` | Type-check + build + test.                    |

Database/Redis/RabbitMQ for local dev: see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## API endpoints (defaults; configurable via env)

| Verb     | Path            | Notes                                                                                                                                                                                      |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET/POST | `/graphql`      | GraphQL HTTP. WebSocket upgrade on GET (graphql-ws protocol).                                                                                                                              |
| GET/POST | `/rest/*`       | REST API (operations + remote-REST proxies).                                                                                                                                               |
| GET      | `/graphiql`     | Bundled GraphiQL playground (single inlined HTML built from `packages/graphiql-playground/`).                                                                                              |
| GET      | `/scalar`       | Bundled Scalar API docs (single inlined HTML built from `packages/scalar-playground/`).                                                                                                    |
| GET      | `/openapi.json` | Unified OpenAPI spec (operations + remote-REST).                                                                                                                                           |
| POST     | `/mcp`          | Model Context Protocol (anonymous-only, opt-in via `ai.mcp.enabled` or `AI_MCP_ENABLED`). Path configurable via `AI_MCP_ENDPOINT`.                                                         |
| POST     | `/ai`           | AI agent — NL → database Q&A (admin-secret only, opt-in via `ai.enabled`). Path configurable via `ai.endpoint`. Also a `superadmin`-only GraphQL `ask(prompt): String` query.              |
| GET      | `/_console`     | Admin console UI (Bun HTMLBundle from `src/console/`) + `/_console/api/*` status APIs (admin-secret gated; `/api/meta` unauth). Opt-in via `CONSOLE_ENABLED`; path via `CONSOLE_ENDPOINT`. |

Auth: `Authorization: Bearer <token>` (header configurable via `AUTHORIZATION_HEADER`). Admin secret: header `x-admin-secret` (configurable via `ADMIN_SECRET_HEADER`). The admin secret bypasses RBAC.

---

## Plan-mode preferences (user)

- Plans should be **extremely concise**. Sacrifice grammar for concision.
- End every plan with a **list of unresolved questions** to answer (or "None" if there genuinely aren't any).
- Don't ask "is the plan okay?" in prose — use `ExitPlanMode`.

---

## Reference docs

| Topic                         | File                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Quickstart                    | [docs/QUICKSTART.md](./docs/QUICKSTART.md)                                                                              |
| Configuration reference       | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)                                                                        |
| API reference (exports)       | [docs/API_REFERENCE.md](./docs/API_REFERENCE.md)                                                                        |
| Auth                          | [docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md)                                                                      |
| Permissions / RBAC            | [docs/PERMISSIONS.md](./docs/PERMISSIONS.md)                                                                            |
| Operations                    | [docs/OPERATIONS.md](./docs/OPERATIONS.md)                                                                              |
| Directives                    | [docs/DIRECTIVES.md](./docs/DIRECTIVES.md)                                                                              |
| Virtual columns               | [docs/VIRTUAL_COLUMNS.md](./docs/VIRTUAL_COLUMNS.md)                                                                    |
| Cron                          | [docs/CRON.md](./docs/CRON.md)                                                                                          |
| Queues                        | [docs/QUEUES.md](./docs/QUEUES.md)                                                                                      |
| Subscriptions                 | [docs/SUBSCRIPTIONS.md](./docs/SUBSCRIPTIONS.md)                                                                        |
| Remote schemas                | [docs/REMOTE_SCHEMAS.md](./docs/REMOTE_SCHEMAS.md)                                                                      |
| Remote REST                   | [docs/REMOTE_REST.md](./docs/REMOTE_REST.md)                                                                            |
| MCP server                    | [docs/MCP.md](./docs/MCP.md)                                                                                            |
| Admin console                 | [docs/CONSOLE.md](./docs/CONSOLE.md)                                                                                    |
| AI agent                      | [docs/AI.md](./docs/AI.md)                                                                                              |
| React SDK                     | [docs/REACT.md](./docs/REACT.md)                                                                                        |
| Contributing                  | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                                    |
| Changelog                     | [CHANGELOG.md](./CHANGELOG.md)                                                                                          |
| Backlog (deferred follow-ups) | [BACKLOG.md](./BACKLOG.md) — read before adding "future improvement" suggestions; the user item may already be tracked. |

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

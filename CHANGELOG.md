# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

Initial public release. Two packages: `@graphoria/server` (the server, plus the config-authoring surface at `@graphoria/server/config`) and `@graphoria/react` (frontend SDK).

### Added

**Core**

- Auto-generated GraphQL and REST APIs from database schemas. Supported engines: PostgreSQL, SQL Server (MSSQL), and MySQL.
- Role-based access control via per-role schema compilation — each role gets its own GraphQL schema containing only what its permissions allow.
- Configuration as a TypeScript module (`graphoria.ts`), validated with Zod at startup.
- Runs on Bun. `createBunServer` for a batteries-included server, or `createHandlers` / `createGraphQLServer` to embed the handlers in an existing app. Cluster mode included.

**Authentication & security**

- JWT and PASETO (`paseto_local`, `paseto_public`) token strategies, selectable via config or `AUTH_STRATEGY`.
- Refresh-token flow with strict audience separation — refresh tokens cannot be replayed as access tokens.
- Token revocation and replay detection backed by a Redis JTI store; logout revokes both access and refresh tokens.
- Argon2id password hashing, parameterized login queries, and a `graphoria seed-auth` CLI for bootstrapping users. Auth table creation is opt-in (`auth.autoCreateTables`).
- Admin-secret header for RBAC bypass (configurable via `ADMIN_SECRET_HEADER`).

**API surface**

- GraphQL over HTTP and WebSocket subscriptions (graphql-ws) at `/graphql`.
- REST endpoints at `/rest/*` — auto-generated per entity plus custom operations with `init` / `beforeRequest` / `afterRequest` hooks.
- Bundled GraphiQL playground (`/graphiql`), Scalar API docs (`/scalar`), and a unified OpenAPI spec (`/openapi.json`).
- Admin console at `/_console` (opt-in): exposed tables and columns, roles and permission matrix, runtime status with per-database latency, queue publish and cron trigger/pause/resume controls.

**Query features**

- Data-transform directives: `@truncate`, `@replace`, `@concat`, `@pad`, `@dateFormat`, `@round`, `@multiply`, `@divide`, `@default`, `@substring`. Arguments are validated at analysis time and parameterized in SQL.
- `@when` control-flow directive with `and` / `or` arguments for conditional field inclusion.
- Virtual columns computed at query time.
- Table and column description overrides via config, merged with database-sourced comments into the SDL and OpenAPI output.

**Integrations**

- Message queues: RabbitMQ and Kafka (with SASL), with publishers, subscribers, and topics. Queue subscribers double as GraphQL subscription fields.
- Cron jobs with error capture and runtime pause/resume.
- Remote GraphQL schema stitching with prefixing and per-role exposure.
- Remote REST API proxying, merged into the unified OpenAPI spec.
- AI agent (opt-in, admin-secret gated): natural-language database Q&A via `POST /ai` and a superadmin-only `ask` GraphQL query. Providers: Ollama (default), OpenAI, Anthropic, DeepSeek.
- MCP server (opt-in) at `/mcp` exposing `list_entities`, `describe_entity`, and `graphql_execute` tools.

**Observability & performance**

- Structured JSON logging with pino — per-subsystem child loggers, `LOG_LEVEL` control, pretty output in development, custom logger injection via `configureLogging`.
- Per-role LRU query cache reusing parse/validate/analyze results for repeated queries.

**React SDK (`@graphoria/react`)**

- Apollo-based client factory, auth-aware provider, and hooks for queries, mutations, and subscriptions against a Graphoria server.

[0.1.0]: https://github.com/graphoria/graphoria/releases/tag/v0.1.0

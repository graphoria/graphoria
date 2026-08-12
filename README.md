# Graphoria

[![Apache 2.0 License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://choosealicense.com/licenses/apache-2.0/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](#)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](#)
[![GraphQL](https://img.shields.io/badge/GraphQL-E10098?logo=graphql&logoColor=white)](#)

## Contents

- [Graphoria](#graphoria)
  - [Contents](#contents)
  - [⚠️ Pre-1.0 Stability](#️-pre-10-stability)
  - [Features](#features)
  - [Why Graphoria?](#why-graphoria)
  - [Who is this for?](#who-is-this-for)
  - [How it works](#how-it-works)
  - [Coming Before v1.0](#coming-before-v10)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Try it now](#try-it-now)
  - [Quick Start](#quick-start)
    - [Environment](#environment)
    - [Standalone Server](#standalone-server)
    - [Logging](#logging)
    - [Integration with Existing Bun App](#integration-with-existing-bun-app)
    - [Configuration File](#configuration-file)
    - [Run it \& try a query](#run-it--try-a-query)
    - [Field naming](#field-naming)
  - [API Endpoints](#api-endpoints)
  - [Supported Databases](#supported-databases)
  - [Environment Variables](#environment-variables)
  - [Troubleshooting](#troubleshooting)
  - [Production Checklist](#production-checklist)
  - [Packages](#packages)
  - [Documentation](#documentation)
  - [Contributing](#contributing)
    - [1. Fork \& Clone](#1-fork--clone)
    - [2. Install Dependencies](#2-install-dependencies)
    - [3. Setup Development Environment](#3-setup-development-environment)
    - [4. Make Changes](#4-make-changes)
    - [5. Submit Pull Request](#5-submit-pull-request)
  - [License](#license)
  - [Author \& Maintainer](#author--maintainer)
  - [Acknowledgments](#acknowledgments)

> **Instant GraphQL & REST APIs from your database** — with built-in auth, message queues, cron jobs, and real-time subscriptions.

Graphoria connects to your database, introspects the schema, and generates a complete GraphQL and REST API layer — including CRUD operations, relationships, filtering, and ordering. On top of that, it integrates RabbitMQ and Kafka for event-driven workflows, supports scheduled background tasks with cron, and provides custom operations with type-safe handlers.

Built with [Bun](https://bun.sh/) and TypeScript for maximum performance.

> **v0.1.0** — All features are working. Breaking changes are expected before v1.0. See [below](#pre-10-stability) for details.

## ⚠️ Pre-1.0 Stability

Graphoria is under active development. Until v1.0:

- **Breaking changes are expected** — the configuration shape, API surface, and package structure may change between minor versions.
- **Every breaking change is documented** in [`CHANGELOG.md`](./CHANGELOG.md) with migration guidance.
- **Semantic versioning applies from v1.0 onward.** Before then, treat each `0.x` bump as potentially breaking.

We ship fast and fix forward. If you're evaluating Graphoria for production, pin your version (`0.1.0` not `^0.1.0`) and read the changelog before upgrading.

## Features

- **Auto-generated GraphQL API** from database schema with zero configuration
- **Auto-generated REST API** from GraphQL schema for maximum compatibility
- **Multi-database support** — PostgreSQL, SQL Server (MSSQL), MySQL
- **JWT or PASETO authentication** with argon2id password hashing and role-based access control (RBAC)
- **Row-level security** — per-role filters with session variable injection
- **Real-time subscriptions** via WebSocket (`graphql-ws` protocol)
- **Message queues** — RabbitMQ and Kafka with pub/sub and cache invalidation
- **Cron jobs** — scheduled background tasks with optional GraphQL query execution
- **Custom operations** — type-safe query and handler-based endpoints with Zod validation
- **Remote GraphQL schemas** — stitch external GraphQL APIs into the unified schema
- **Remote REST APIs** — proxy external OpenAPI services under `/rest`
- **Virtual columns** — computed columns powered by SQL expressions or functions
- **GraphQL directives** — `@where`, `@truncate`, `@replace`, `@concat`, and more for data transformation
- **AI agent** — admin-only natural-language → database Q&A, exposed as GraphQL `ask` query and REST endpoint
- **MCP server** — Model Context Protocol server so AI editors can explore your schema as tools
- **Admin console** — web UI at `/_console` for tables, roles, permissions, API docs, and runtime status
- **LRU cache** with queue-driven invalidation
- **Built-in playgrounds** — GraphiQL and Scalar API documentation
- **OpenAPI** spec generation from operations
- **React SDK** — `@graphoria/react` with auth hooks, Apollo Client, and route-based access control
- **Structured logging** — pino-based JSON logging with configurable levels

## Why Graphoria?

Graphoria gives you a **Hasura-grade GraphQL API** — plus queues, cron, an AI agent, an MCP server, and an admin console — in a single Bun binary. No stitching together five services. No YAML-driven middleware. Write a TypeScript config file and you're done.

| You want…                                | Hasura CE | PostGraphile | Graphoria |
| ---------------------------------------- | :-------: | :----------: | :-------: |
| Auto-generated GraphQL + REST            |    ✅     |      ✅      |    ✅     |
| PostgreSQL, MySQL, MSSQL                 |    ✅     |   ✅ (PG)    |    ✅     |
| JWT + PASETO auth with RBAC              |    ✅     |      —       |    ✅     |
| Built-in message queues (RabbitMQ/Kafka) |     —     |      —       |    ✅     |
| Built-in cron jobs                       |    ✅     |      —       |    ✅     |
| Admin console UI                         |    ✅     |      —       |    ✅     |
| AI agent (NL → DB queries)               |     —     |      —       |    ✅     |
| MCP server (AI editor integration)       |     —     |      —       |    ✅     |
| Remote schema stitching + REST proxy     |    ✅     |      —       |    ✅     |
| Virtual columns + directives             |     —     |   ✅ (PG)    |    ✅     |
| Runtime                                  |  Haskell  |   Node.js    |    Bun    |

## Who is this for?

Graphoria is for **backend developers and small-to-medium teams** who want:

- A **Hasura-grade GraphQL API** without the operational overhead of Haskell or the limitations of the Community Edition.
- **One binary** that handles the API layer, authentication, async workloads (queues + cron), and AI integration — no stitching together five services.
- **TypeScript-native configuration** — no YAML, no DSL, just a `graphoria.ts` file with full autocomplete.
- **AI-ready schemas** — the built-in MCP server exposes your database as tools to AI editors with zero extra setup.

## How it works

```mermaid
flowchart TB
    subgraph Clients[" "]
        GQL["GraphQL<br/>(queries, mutations, subscriptions)"]
        REST["REST<br/>(operations, remote proxies)"]
        AI["AI / MCP<br/>(agent tools, editor)"]
        CONSOLE["Admin Console<br/>(/_console)"]
    end

    subgraph Graphoria["Graphoria"]
        AUTH["Auth<br/>(JWT, PASETO, RBAC)"]
        CACHE["Query Cache<br/>(LRU per-role)"]
        QUEUES["Queues<br/>(RabbitMQ, Kafka)"]
        CRON["Cron<br/>(scheduled jobs)"]
        AGENT["AI Agent<br/>(LLM tools)"]
        MCP["MCP Server<br/>(schema tools)"]
        REMOTE["Remote<br/>(GQL stitch, REST proxy)"]
    end

    subgraph Data[" "]
        PG[("PostgreSQL")]
        MSSQL[("SQL Server")]
        MYSQL[("MySQL")]
        REDIS[("Redis")]
    end

    Clients --> Graphoria
    Graphoria --> Data
```

## Coming Before v1.0

What's actively being built or on the near-term roadmap:

| Milestone                                                                             | Status      |
| ------------------------------------------------------------------------------------- | ----------- |
| **Website & documentation hub**                                                       | Planned     |
| **Configuration stabilization** — single source of truth via Zod, final shape lock-in | In progress |
| **`graphoria init` CLI** — scaffold a project with one command                        | Planned     |
| **Official Docker images** — multi-arch, published to GHCR                            | Planned     |
| **SQLite support** — embedded database for edge and local dev                         | Planned     |
| **Rate limiting & throttling** — per-role, per-operation                              | Planned     |
| **Metrics & tracing** — OpenTelemetry integration                                     | Planned     |

Want to influence the roadmap? [Open an issue](https://github.com/graphoria/graphoria/issues) or upvote existing ones.

## Prerequisites

- [Bun](https://bun.sh) **1.3.4** or newer
- A running database — PostgreSQL, MySQL, or SQL Server. The examples use PostgreSQL on `localhost:5432`.
- [Redis](https://redis.io) (or Valkey) — only required if you enable authentication. The default URL is `redis://localhost:6379`.

Don't have Postgres/Redis handy? The [`examples/`](./examples) folder ships a `docker-compose.yml` that starts Postgres, Redis, and RabbitMQ with credentials matching the examples below:

```bash
docker compose -f examples/docker-compose.yml up -d
```

## Installation

```bash
bun add @graphoria/server
```

## Try it now

The [`examples/taskly/`](./examples/taskly) folder is a **complete, ready-to-run demo** — a multi-tenant task tracker with auth, RBAC, queues, cron, subscriptions, operations, and a React frontend. Clone the repo, `docker compose up`, `bun run index.ts`, and you're live in minutes. Every feature in this README is wired up and documented there.

## Quick Start

### Environment

Secrets are read from the environment, not passed as options. Bun auto-loads a `.env` file. `ADMIN_SECRET` is **always required** (the server will not boot without it), and `JWT_SECRET` is required for the default JWT auth strategy:

```bash
# .env
ADMIN_SECRET=dev-admin-change-me
JWT_SECRET=dev-secret-change-me
```

See [`.env.example`](./.env.example) for every supported variable.

### Standalone Server

```typescript
import { createBunServer } from "@graphoria/server";

// ADMIN_SECRET and JWT_SECRET are read from the environment (e.g. a .env file).
const { server, prefixes } = await createBunServer({
  port: 3000,
  configuration: "./graphoria.ts",
});

console.log(`Server running on http://localhost:${server.port}`);
console.log(`GraphQL:  ${prefixes.graphql}`);
console.log(`REST:     ${prefixes.rest}`);
console.log(`GraphiQL: ${prefixes.graphiql}`);
```

### Logging

Graphoria uses [pino](https://getpino.io) for structured JSON logging. Set `LOG_LEVEL` to control verbosity (`debug` in dev, `info` in prod by default). In development, `pino-pretty` formats output for readability.

```bash
LOG_LEVEL=trace bun run dev
```

To inject your own pino logger or customize options:

```typescript
import pino from "pino";
import { createBunServer, configureLogging } from "@graphoria/server";

// Option A: pass via createBunServer
const { server } = await createBunServer({
  logger: pino({ level: "trace", redact: ["req.headers.authorization"] }),
});

// Option B: pass pino options (you own full config)
const { server } = await createBunServer({
  logger: {
    level: "trace",
    transport: { target: "pino/file", options: { destination: "/var/log/app.log" } },
  },
});

// Option C: call configureLogging before anything else (first-write-wins)
configureLogging({ level: "trace" });
```

### Integration with Existing Bun App

```typescript
import { createHandlers } from "@graphoria/server";

const { serverHandlers } = await createHandlers({
  configuration: "./graphoria.ts",
});

const server = Bun.serve({
  port: 3000,
  routes: {
    "/health": () => new Response("OK"),
    ...serverHandlers.routes,
  },
  websocket: serverHandlers.websocket,
});
```

### Configuration File

Create a `graphoria.ts` configuration file:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ operation }) => ({
  name: "my-api",
  version: "1.0.0", // your API's version — not Graphoria's
  databases: [
    {
      name: "pg",
      type: "pg",
      enabled: true,
      connection: {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "postgres",
        database: "my_app",
      },
    },
  ],
  auth: {
    enabled: true,
    database: "pg",
    permissions: {
      anonymous: { tables: "ALL", operations: "ALL" },
      admin: {
        tables: "ALL",
        storedProcedures: "ALL",
        queues: "ALL",
        operations: "ALL",
      },
    },
  },
  operations: {
    getProducts: operation({
      query: `query { public_products { id name price } }`,
      description: "Get all products",
      rest: { path: "/products", method: "GET" },
    }),
  },
})) satisfies ConfigurationFn;
```

### Run it & try a query

Start the server:

```bash
bun run index.ts
```

Open `http://localhost:3000/graphiql` in your browser. The playground lists every table from your database, with relationships, filters, ordering, and pagination wired up automatically. Try a query:

```graphql
query {
  public_products(limit: 10, where: { id: { eq: 1 } }) {
    id
    name
  }
}
```

Or hit the REST endpoint declared by the operation above:

```bash
curl 'http://localhost:3000/rest/products'
```

### Field naming

Generated GraphQL fields follow the `{schema}_{name}` pattern by default — e.g. the `products` table in the `public` schema becomes `public_products`. Override it per database with the `fieldNaming` config field, using the `{database}`, `{schema}`, `{name}`, and `{type}` placeholders (e.g. `"{database}_{schema}_{name}"` to disambiguate tables across multiple databases).

## API Endpoints

| Verb     | Path            | Description                                                   |
| -------- | --------------- | ------------------------------------------------------------- |
| GET/POST | `/graphql`      | GraphQL HTTP. WebSocket upgrade on GET (graphql-ws protocol). |
| GET/POST | `/rest/*`       | REST API (operations + remote-REST proxies).                  |
| GET      | `/graphiql`     | Bundled GraphiQL playground.                                  |
| GET      | `/scalar`       | Bundled Scalar API docs.                                      |
| GET      | `/openapi.json` | Unified OpenAPI spec (operations + remote-REST).              |
| POST     | `/mcp`          | Model Context Protocol server (anonymous, opt-in).            |
| POST     | `/ai`           | AI agent — NL → database Q&A (admin-secret only, opt-in).     |
| GET      | `/_console`     | Admin console UI + status APIs (admin-secret gated, opt-in).  |

All paths are configurable via environment variables. Auth: `Authorization: Bearer <token>`. Admin: `x-admin-secret` header.

## Supported Databases

| Database           | Status       | Features                                   |
| ------------------ | ------------ | ------------------------------------------ |
| PostgreSQL         | Full support | Tables, views, relationships, stored procs |
| SQL Server (MSSQL) | Full support | Tables, views, relationships, stored procs |
| MySQL              | Full support | Tables, views, relationships               |

## Environment Variables

The variables you'll most likely touch for a first run. See [`.env.example`](./.env.example) for the full list.

| Variable        | Default                  | Description                                                                                              |
| --------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `ADMIN_SECRET`  | _(required)_             | Master secret; sent in the admin header it bypasses RBAC. No default — the server won't boot without it. |
| `JWT_SECRET`    | _(required for JWT)_     | HMAC secret for signing tokens under the default `jwt` strategy.                                         |
| `PORT`          | `3000`                   | HTTP port the server listens on.                                                                         |
| `CACHE_STORE`   | `memory`                 | `memory` or `redis`. Use `redis` (and `REDIS_URL`) when auth is enabled.                                 |
| `REDIS_URL`     | `redis://localhost:6379` | Redis/Valkey URL — required when authentication is enabled.                                              |
| `AUTH_STRATEGY` | `jwt`                    | `jwt`, `paseto_local`, or `paseto_public`.                                                               |

## Troubleshooting

- **Server exits immediately on boot** — `ADMIN_SECRET` is unset. Add it to your `.env`.
- **Auth requests fail / token errors** — Redis isn't reachable. Start it (`docker compose -f examples/docker-compose.yml up -d redis`) and check `REDIS_URL`.
- **`Cannot connect to database`** — confirm the database is running and the `connection` block in `graphoria.ts` matches its host/port/credentials.

## Production Checklist

Before going to production:

- [ ] Set a strong `ADMIN_SECRET` — it bypasses all RBAC.
- [ ] Rotate `JWT_SECRET` (or `PASETO_SECRET`) — never use the dev default.
- [ ] Put Redis behind authentication — set a password and use `redis://user:pass@host:port` in `REDIS_URL`.
- [ ] Enable CORS properly — set `CORS_ORIGIN` to your frontend's origin, not `*`.
- [ ] Use a reverse proxy (nginx, Caddy) for TLS termination.
- [ ] Pin your Graphoria version — `0.1.0`, not `^0.1.0` — until v1.0.

## Packages

| Package                                  | Description                                                         |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [`@graphoria/server`](./packages/server) | Main server — API generation, auth, queues, cron                    |
| [`@graphoria/react`](./packages/react)   | React hooks for auth, Apollo Client, and route-based access control |

## Documentation

**Getting started**

| Guide                                              | Description                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| [Quickstart](./docs/QUICKSTART.md)                 | Zero to a running server in five minutes                              |
| [Configuration Reference](./docs/CONFIGURATION.md) | Full configuration schema — databases, auth, operations, queues, cron |
| [API Reference](./docs/API_REFERENCE.md)           | Complete package exports for server, config, and react                |

**Features**

| Guide                                                 | Description                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [Authentication](./docs/AUTHENTICATION.md)            | JWT and PASETO strategies, argon2id passwords, refresh-token rotation |
| [Permissions & Access Control](./docs/PERMISSIONS.md) | RBAC, row-level filtering, session variables, ordering                |
| [Operations](./docs/OPERATIONS.md)                    | Custom query and handler operations, hooks, caching                   |
| [Cron Jobs](./docs/CRON.md)                           | Scheduled background work with cron expressions and ISO datetimes     |
| [Queues](./docs/QUEUES.md)                            | RabbitMQ and Kafka publishers, subscribers, cache invalidation        |
| [Subscriptions](./docs/SUBSCRIPTIONS.md)              | GraphQL subscriptions over WebSockets                                 |
| [GraphQL Directives](./docs/DIRECTIVES.md)            | Built-in data-transformation and `@when` control-flow directives      |
| [Virtual Columns](./docs/VIRTUAL_COLUMNS.md)          | Computed columns powered by SQL expressions or functions              |
| [Remote GraphQL Schemas](./docs/REMOTE_SCHEMAS.md)    | Stitch external GraphQL APIs into the unified schema                  |
| [Remote REST APIs](./docs/REMOTE_REST.md)             | Proxy external OpenAPI services under `/rest`                         |
| [AI Agent](./docs/AI.md)                              | Admin-only natural-language → database Q&A over GraphQL and REST      |
| [MCP Server](./docs/MCP.md)                           | Model Context Protocol server — schema as tools for AI editors        |
| [Admin Console](./docs/CONSOLE.md)                    | Web UI for tables, roles, permissions, API docs, and runtime status   |
| [React SDK](./docs/REACT.md)                          | `@graphoria/react` hooks, providers, and Apollo integration           |

## Contributing

We welcome contributions! Please follow these steps:

### 1. Fork & Clone

```bash
git clone https://github.com/graphoria/graphoria.git
cd graphoria
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Setup Development Environment

```bash
cp .env.example .env
bun run dev
```

### 4. Make Changes

- Create a feature branch: `git checkout -b feature/amazing-feature`
- Write tests for new functionality
- Ensure all tests pass: `bun test`
- Follow the existing code style
- Add documentation for new features

### 5. Submit Pull Request

- Commit your changes: `git commit -m 'Add amazing feature'`
- Push to your branch: `git push origin feature/amazing-feature`
- Open a Pull Request with a clear description

## License

This project is licensed under the **Apache License 2.0** — see the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for details.

```
Copyright 2026 Alex Ferreli

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Author & Maintainer

**Alex Ferreli** — _Creator & Lead Developer_

- GitHub: [@Alex-Ferreli](https://github.com/Alex-Ferreli)
- Email: [ferreli.ale@gmail.com](mailto:ferreli.ale@gmail.com)
- Repository: [graphoria](https://github.com/graphoria/graphoria)

## Acknowledgments

- **Inspired by**: [Hasura](https://hasura.io/) — For pioneering instant GraphQL APIs
- **Powered by**: [Bun](https://bun.sh/) — For incredible runtime performance
- **Built with**: [GraphQL](https://graphql.org/) — For modern API architecture
- **TypeScript** — For developer experience and type safety

---

<div align="center">

**[Star this repo](https://github.com/graphoria/graphoria)** if you find it useful!

**Made with care by developers, for developers**

</div>

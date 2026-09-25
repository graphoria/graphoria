# Quickstart

> **See also:** [Configuration Reference](./CONFIGURATION.md) | [Authentication](./AUTHENTICATION.md) | [Operations](./OPERATIONS.md)

This guide gets you from zero to a running Graphoria server in about five minutes. By the end you will have a server that auto-generates a GraphQL and REST API from a PostgreSQL database, with a built-in playground for trying it out.

## Prerequisites

- [Bun](https://bun.sh) **1.3.4** or newer
- A running database — PostgreSQL, MySQL, or SQL Server. The examples use PostgreSQL on `localhost:5432`.
- Optional: [Redis](https://redis.io) (or Valkey) — only required if you enable authentication. The default URL is `redis://localhost:6379`.

## Scaffold a project with `bunx graphoria init`

The shortest way in needs Docker with Compose instead of a running database. In an empty directory:

```bash
mkdir my-api && cd my-api
bunx graphoria init
```

`init` asks for the database engine (`pg`, `mysql` or `mssql`), the database name, its password, the port it gets on your machine and whether to add a React frontend; Enter takes the default shown. It then writes the project and runs `bun install`:

| File                                          | What it holds                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `graphoria.ts`                                | The configuration. It reads the database connection from the environment.                                                        |
| `index.ts`                                    | The entry point.                                                                                                                 |
| `.env`                                        | A random `ADMIN_SECRET` and `JWT_SECRET`, and the database settings (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`). |
| `docker-compose.yml`                          | The database and Graphoria. The database's port is published on your machine too.                                                |
| `Dockerfile`, `.dockerignore`                 | The image recipe of the [Docker Compose starter](../examples/docker-compose-starter/).                                           |
| `seed.sql`                                    | Two related tables, `authors` and `books`, with a few rows.                                                                      |
| `package.json`, `tsconfig.json`, `.gitignore` | The usual; `.gitignore` keeps `.env` out of git.                                                                                 |

Run everything in Docker:

```bash
docker compose up -d --build
```

Or run the database in Docker and Graphoria on your machine, where `bun run dev` reloads on every change:

```bash
docker compose up -d --wait db   # SQL Server: docker compose run --rm db-init
bun run dev
```

Open `http://localhost:3000/graphiql`, add the `x-admin-secret` header with the `ADMIN_SECRET` from `.env`, and query the seed:

```graphql
{
  public_authors {
    name
    public_books {
      title
    }
  }
}
```

Field names start with the schema: `public_` on PostgreSQL, `dbo_` on SQL Server, and the database name on MySQL (`app_authors` with the default name).

`--yes` takes every default without asking, `--database pg|mysql|mssql` picks the engine, and `--no-install` skips `bun install` (run it before `docker compose up`: the Dockerfile installs from `bun.lock`). `init` writes nothing when a file it would create already exists. `bunx @graphoria/server init` is the same command.

### Add a React frontend with `--frontend`

Answer yes to `Add a React frontend?`, or pass `--frontend` (`--no-frontend` answers no, and so does `--yes` alone). The project then gets a one-page React app, served by the same Bun server on `http://localhost:3000`, that lists the seed's authors with their books:

| File                                                | What it holds                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `web/index.html`, `web/frontend.tsx`, `web/App.tsx` | The page, its entry point, and the component that queries the seed with [urql](https://nearform.com/open-source/urql/). |
| `web/graphql.ts`                                    | [gql.tada](https://gql-tada.0no.co/), which types each query from the schema.                                           |
| `web/styles.css`, `bunfig.toml`                     | Tailwind CSS, which Bun builds through `bun-plugin-tailwind`.                                                           |

Five files change too: `graphoria.ts` opens the seed to anonymous reads (below); `index.ts` serves the app on `/` next to Graphoria's routes (`createHandlers` and `Bun.serve`, as in [Embedding into an existing Bun app](#5-embedding-into-an-existing-bun-app)); `package.json` adds React, urql, gql.tada and Tailwind, and a `types` script; `tsconfig.json` adds the DOM, JSX and the gql.tada TypeScript plugin; `.gitignore` adds `.graphoria`.

The app has no login. `graphoria.ts` leaves auth off and grants the `anonymous` role the two seed tables, so anyone who reaches the server reads them without a secret, in GraphiQL too. Tables are read-only in the generated API. Take the grant out before those tables hold anything that is not public: it applies whether auth is on or off.

The query types come from the schema, which `bun run dev` prints to `.graphoria/schemas/`. Once it has, run:

```bash
bun run types
```

It writes `web/graphql-env.d.ts`; commit that file. Until it exists the app still runs, but `tsc` reports errors in `web/`. After a change to the tables, restart `bun run dev` and run `bun run types` again.

The rest of this guide sets a project up by hand, against a database you already run.

## 1. Install

Create a new project directory and install the runtime package:

```bash
mkdir my-api && cd my-api
bun init -y
bun add @graphoria/server
```

`@graphoria/server` is all you need: the runtime is exported from `@graphoria/server`, and the configuration helpers + types are exported from `@graphoria/server/config`.

## 2. Write a configuration file

Create `graphoria.ts` in the project root:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ operation }) => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    {
      name: "main",
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
  operations: {
    health: operation({
      query: `query { __typename }`,
      description: "Health check",
      rest: { path: "/health", method: "GET" },
    }),
  },
})) satisfies ConfigurationFn;
```

The `satisfies ConfigurationFn` clause keeps your config strictly typed without forcing you to annotate every field. The helpers passed to your function (`z`, `operation`, `cron`, `virtualColumnExpression`, …) are all type-aware — your editor will autocomplete every option as you type.

## 3. Create the entry point

Create `index.ts` next to your config:

```typescript
import { createBunServer } from "@graphoria/server";

const { server, prefixes } = await createBunServer({
  configuration: "./graphoria.ts",
  port: 3000,
});

console.log(`GraphQL  → http://localhost:${server.port}${prefixes.graphql}`);
console.log(`REST     → http://localhost:${server.port}${prefixes.rest}`);
console.log(`GraphiQL → http://localhost:${server.port}${prefixes.graphiql}`);
console.log(`Scalar   → http://localhost:${server.port}${prefixes.scalar}`);
```

`createBunServer()` reads your configuration, introspects the database, builds the schema, and starts a Bun HTTP server. It returns the `server` instance plus the URL prefixes for each endpoint, so you can log them or redirect from your own routes.

Secrets are read from the environment, not passed as options. Bun auto-loads a `.env` file — `ADMIN_SECRET` is always required, and `JWT_SECRET` is required for the default JWT strategy:

```bash
# .env
ADMIN_SECRET=dev-admin-change-me
JWT_SECRET=dev-secret-change-me
```

## 4. Run it

```bash
bun run index.ts
```

Open `http://localhost:3000/graphiql` in your browser. The playground will list every table from your database, with relationships, filters, ordering, and pagination wired up automatically.

Try a query:

```graphql
query {
  public_users(limit: 10, where: { id: { eq: 1 } }) {
    id
    name
  }
}
```

A list field that asks for no `limit` is served one page — 100 rows by default — and a field asking for more than 1000 is rejected. `DEFAULT_PAGE_SIZE` and `MAX_PAGE_SIZE` set both; either takes `0` to opt out. Nested to-many lists take `limit` and `offset` too, and carry the same default.

Every statement is also bounded in time: one still running after 10 seconds is aborted by the database itself, not merely abandoned by the client. `QUERY_TIMEOUT_MS` moves the bound and `0` removes it. See [Bounding how long a statement runs](./CONFIGURATION.md#bounding-how-long-a-statement-runs).

Outside the playground, send queries and mutations to `/graphql` as a `POST` with a JSON body, and the admin secret from `.env` in the `x-admin-secret` header:

```bash
curl http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  -H 'x-admin-secret: dev-admin-change-me' \
  -d '{"query":"{ public_users(limit: 10) { id name } }"}'
```

`GET /graphql` only upgrades to the WebSocket that carries [subscriptions](./SUBSCRIPTIONS.md); any other `GET` answers `404`. Some clients send queries as `GET` — urql does by default — so switch them to `POST` (`preferGetMethod: false` on urql's `Client`).

The corresponding REST endpoint is also live:

```bash
curl 'http://localhost:3000/rest/health'
```

## 5. Embedding into an existing Bun app

If you already have a Bun server, use `createHandlers()` instead. It returns the route map and WebSocket handler, and you compose them into your own `Bun.serve` call:

```typescript
import { createHandlers } from "@graphoria/server";

const { serverHandlers, prefixes } = await createHandlers({
  configuration: "./graphoria.ts",
});

Bun.serve({
  port: 3000,
  routes: {
    "/health": () => new Response("OK"),
    ...serverHandlers.routes,
  },
  websocket: serverHandlers.websocket,
});
```

This pattern is useful when you want to mount Graphoria under a path prefix, add custom middleware, or share a port with other handlers.

## What's next?

- **Add authentication** — [Authentication](./AUTHENTICATION.md) covers JWT, PASETO, and how the built-in `auth_login` / `auth_refresh` operations work.
- **Lock things down** — [Permissions & Access Control](./PERMISSIONS.md) explains role-based access control, row-level filters, and session variables.
- **Define your own endpoints** — [Operations](./OPERATIONS.md) walks through query operations, custom handlers, and hook lifecycle.
- **Schedule background work** — [Cron Jobs](./CRON.md) documents the cron config and tick callback shape.
- **Wire up message queues** — [Queues](./QUEUES.md) covers RabbitMQ and Kafka integration with cache invalidation.
- **Stitch in external APIs** — [Remote GraphQL Schemas](./REMOTE_SCHEMAS.md) and [Remote REST APIs](./REMOTE_REST.md) merge external services into your unified API.

If you build a frontend, the `@graphoria/react` package ships with a client-agnostic auth provider, role-based render gates, and route-based access control helpers. Bring your own GraphQL client. See [React SDK](./REACT.md).

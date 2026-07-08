# Quickstart

> **See also:** [Configuration Reference](./CONFIGURATION.md) | [Authentication](./AUTHENTICATION.md) | [Operations](./OPERATIONS.md)

This guide gets you from zero to a running Graphoria server in about five minutes. By the end you will have a server that auto-generates a GraphQL and REST API from a PostgreSQL database, with a built-in playground for trying it out.

## Prerequisites

- [Bun](https://bun.sh) **1.3.4** or newer
- A running database — PostgreSQL, MySQL, or SQL Server. The examples use PostgreSQL on `localhost:5432`.
- Optional: [Redis](https://redis.io) (or Valkey) — only required if you enable authentication. The default URL is `redis://localhost:6379`.

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

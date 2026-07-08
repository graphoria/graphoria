# @graphoria/server

The runtime that powers Graphoria — schema introspection, GraphQL/REST handlers, JWT/PASETO authentication, RBAC, message queues, cron, remote schemas, and remote REST integration. This package is what you install into a Bun application to get a complete API server out of one configuration file.

> Looking for the full guide? Start with the [Quickstart](../../docs/QUICKSTART.md), then dig into the topic-specific docs in [`docs/`](../../docs/).

## Install

```bash
bun add @graphoria/server
```

Installing the server package is enough: the runtime is exported from `@graphoria/server` and the configuration helpers + types from `@graphoria/server/config`.

## Public API

```typescript
import { createGraphQLEngine, createHandlers, createBunServer } from "@graphoria/server";
```

| Export                | Use                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `createBunServer`     | Spin up a `Bun.serve` server end-to-end. Returns `{ server, prefixes, execute }`.                                           |
| `createHandlers`      | Build the route map and websocket handler so you can compose them with your own server. Also returns `execute`.             |
| `createGraphQLEngine` | Run GraphQL queries in-process — no server. Returns `{ execute, roles, close }`. `execute` bypasses auth (full privileges). |

`createBunServer` and `createHandlers` also return `execute`, the same in-process query runner as `createGraphQLEngine`, bound to the running server's schema.

### One-call setup

```typescript
import { createBunServer } from "@graphoria/server";

// JWT_SECRET and ADMIN_SECRET are read from the environment (see below).
const { server, prefixes } = await createBunServer({
  configuration: "./graphoria.ts",
  port: 3000,
});
```

### Embedding into an existing Bun.serve

```typescript
import { createHandlers } from "@graphoria/server";

const { serverHandlers } = await createHandlers({
  configuration: "./graphoria.ts",
});

Bun.serve({
  port: 3000,
  routes: { "/health": () => new Response("OK"), ...serverHandlers.routes },
  websocket: serverHandlers.websocket,
});
```

### Running a query without a server

```typescript
import { createGraphQLEngine } from "@graphoria/server";

const { execute, close } = await createGraphQLEngine({
  configuration: "./graphoria.ts",
});

// Defaults to the superadmin role (full privileges); pass { role } to scope it.
const result = await execute("query { users { id name } }");
console.log(result);

await close(); // release database connections
```

`execute` bypasses authentication — there is no token verification — so don't expose it to untrusted input. Because no HTTP request exists, operation `init`/`beforeRequest` hooks and header-derived session variables do not run.

## Environment variables

The server reads a small set of environment variables. Every variable has a sensible default except `JWT_SECRET` (or PASETO equivalents) and `ADMIN_SECRET`, both of which are required.

| Variable               | Default                        | Purpose                                                                    |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `PORT`                 | `3000`                         | HTTP port for `createBunServer`.                                           |
| `JWT_SECRET`           | _required_                     | Symmetric secret for JWT signing.                                          |
| `JWT_EXPIRES_IN`       | `5m`                           | Access-token lifetime.                                                     |
| `JWT_RT_EXPIRES_IN`    | `7d`                           | Refresh-token lifetime.                                                    |
| `PASETO_LOCAL_KEY`     | _required for_ `paseto_local`  | XChaCha20-Poly1305 key (`k4.local.…`).                                     |
| `PASETO_SECRET_KEY`    | _required for_ `paseto_public` | Ed25519 secret (`k4.secret.…`).                                            |
| `PASETO_PUBLIC_KEY`    | _required for_ `paseto_public` | Ed25519 public (`k4.public.…`).                                            |
| `ADMIN_SECRET`         | _required_                     | Bypasses RBAC when sent in the admin header.                               |
| `REDIS_URL`            | `redis://localhost:6379`       | Refresh-token rotation + cache.                                            |
| `GRAPHQL_API_ENDPOINT` | `/graphql`                     | GraphQL endpoint path.                                                     |
| `REST_API_PREFIX`      | `/rest`                        | REST API prefix.                                                           |
| `GRAPHIQL_ENDPOINT`    | `/graphiql`                    | Built-in GraphiQL playground path.                                         |
| `SCALAR_ENDPOINT`      | `/scalar`                      | Scalar API documentation path.                                             |
| `OPENAPI_ENDPOINT`     | `/openapi.json`                | OpenAPI document path.                                                     |
| `CORS_ENABLED`         | `true`                         | Toggle CORS preflight handler.                                             |
| `MAX_QUERY_DEPTH`      | `0` (disabled)                 | Reject queries deeper than this — guard against abusive nested selections. |

The complete list lives in [`packages/server/src/types/env.ts`](./src/types/env.ts).

## Configuration helpers

Import the configuration helpers — plus `ConfigurationFn` and the config types — from `@graphoria/server/config`:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";
import {
  operation,
  cron,
  z,
  queue,
  virtualColumnExpression,
  virtualColumnFunction,
  createOneToBooleanMSSQL,
  createYAndNToBooleanMSSQL,
} from "@graphoria/server/config";
```

## See also

- [Quickstart](../../docs/QUICKSTART.md)
- [Configuration Reference](../../docs/CONFIGURATION.md)
- [Authentication](../../docs/AUTHENTICATION.md)
- [Permissions & Access Control](../../docs/PERMISSIONS.md)
- [Operations](../../docs/OPERATIONS.md)
- [Queues](../../docs/QUEUES.md)
- [Cron Jobs](../../docs/CRON.md)
- [Remote GraphQL Schemas](../../docs/REMOTE_SCHEMAS.md)
- [Remote REST APIs](../../docs/REMOTE_REST.md)
- [Subscriptions](../../docs/SUBSCRIPTIONS.md)

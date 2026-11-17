# tRPC

> **See also:** [Operations](./OPERATIONS.md) | [Permissions](./PERMISSIONS.md) | [Resource Limits](./LIMITS.md)

Graphoria can serve every [operation](./OPERATIONS.md) as a [tRPC](https://trpc.io) procedure under `/trpc/*`. A TypeScript client then calls `client.<operation>.query()` or `.mutate()` with the input and output types inferred from `graphoria.ts`, without code generation.

The surface is **opt-in** and covers **operations only**. Tables, stored procedures, queues, remote schemas and remote REST stay on GraphQL and REST: their types exist only after introspection, and [gql.tada](https://gql-tada.0no.co) already types that access.

## Enabling tRPC

Off by default, and switched by the environment alone:

```bash
bun add @trpc/server
TRPC_ENABLED=true bun run start
```

`@trpc/server` is an optional peer of `@graphoria/server` (`^11.28.0`), loaded only when the surface is on. With `TRPC_ENABLED` on and the package missing, boot fails with `TRPC_ENABLED requires @trpc/server (add it to dependencies)`.

| Variable              | Type      | Default | Description                                                  |
| --------------------- | --------- | ------- | ------------------------------------------------------------ |
| `TRPC_ENABLED`        | `boolean` | `false` | Mount the tRPC surface                                       |
| `TRPC_ENDPOINT`       | `string`  | `/trpc` | Path the procedures are served under, itself under `PREFIX`  |
| `TRPC_MAX_BATCH_SIZE` | `number`  | `10`    | Calls one batched request may carry. A larger batch is `400` |

## Calling from a client

The client needs `@trpc/client`, at the same version as the server's `@trpc/server`, and two types: your configuration's, and `TRPCRouterOf` from `@graphoria/server/trpc`.

```typescript
import { createTRPCClient, httpBatchLink } from "@trpc/client";

import type { TRPCRouterOf } from "@graphoria/server/trpc";
import type config from "../graphoria";

const client = createTRPCClient<TRPCRouterOf<typeof config>>({
  links: [
    httpBatchLink({
      url: "/trpc",
      maxItems: 10, // TRPC_MAX_BATCH_SIZE
      headers: () => ({ authorization: `Bearer ${token}` }),
    }),
  ],
});

const orders = await client.getOrdersByCustomer.query({ customerId });
const task = await client.createTask.mutate({ title });
```

Keep `maxItems` at or under `TRPC_MAX_BATCH_SIZE`. The client batches every call of one tick without limit by default, and a batch over the cap fails whole: eleven calls in one tick against the default cap reject all eleven. With `maxItems: 10` the client sends two requests. `httpBatchStreamLink` takes the same option.

The caller is resolved as on `/graphql` and `/rest/*`: `Authorization: Bearer <token>` for the token's role, the admin secret (`x-admin-secret` by default) for the superadmin role, the anonymous role without a credential or with a bad or revoked token.

## Queries and mutations

`rest.method` decides, the same rule that decides whether an operation is a GraphQL mutation:

| `rest.method`                    | Procedure | Called with                   | HTTP                      |
| -------------------------------- | --------- | ----------------------------- | ------------------------- |
| `GET` (the default)              | query     | `client.<name>.query(input)`  | `GET`, input in the URL   |
| `POST`, `PUT`, `PATCH`, `DELETE` | mutation  | `client.<name>.mutate(input)` | `POST`, input in the body |

An operation needs a `rest` route to be a procedure, as it needs one to be served at all. Every operation with one is a procedure, including one with `graphql.enabled: false`.

## Types

The client's types come from what `operation()` returns:

| Type           | Comes from                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Input          | The `input` schema, before parsing: a field with `.default()` is optional. Without `input` the call takes no argument |
| Query output   | The `output` schema; else what `afterRequest` returns; else the gql.tada document's result; else `unknown`            |
| Handler output | The `output` schema; else `unknown`                                                                                   |

`output` describes the answer and is not enforced, as on REST.

Three rules keep the types intact:

- **Use `satisfies ConfigurationFn`** (or `satisfies ConfigurationInput`). `as ConfigurationInput` or a `: ConfigurationFn` annotation erases the literal types: the router type is then empty and every client call fails to compile.
- **Build operations with `operation()` or `operation.typed()`.** A bare object literal is still served, but the client type lacks it.
- **Declare arguments under `input`.** `rest.pathParams`, `rest.queryParams` and `rest.body` are REST's and are not read here. An operation that declares one of them and no `input` is a procedure without arguments; boot logs a `warn` naming those operations.

The router type lists every operation in the configuration. It cannot know the caller's role, nor what the server left out, so a few calls compile and still answer `NOT_FOUND`: see [Errors](#errors).

## How a call runs

A call runs the pipeline its REST route runs: `init`, `beforeRequest`, the handler or the query (with its `timeout` and `cache`), then `afterRequest`. `init` shares its REST route's memo: it runs on the operation's first call, whichever surface makes it, and, as on REST, calls that arrive while it is still running each run it too. The calls of one batch arrive together, so keep `init` idempotent. Four things differ from REST:

- **One input.** The procedure parses `input`, and that is the handler's input or the query's variables.
- **`beforeRequest` gets no REST source.** Its `pathParams`, `queryParams` and `body` are always `undefined`. A hook that serves both surfaces reads `input`.
- **The payload is unwrapped.** A query operation answers its data, after `afterRequest`, not REST's `{ data }` envelope: tRPC wraps it in its own.
- **Cache entries are separate.** A cached query operation keeps its tRPC answers in the operation's own store, keyed by the operation, the input and the caller's `sub` and role. A REST call and a tRPC call never share an entry, and `cache.invalidate(name, pattern?)` clears both.

## Errors

Errors arrive as a `TRPCClientError`; `error.data.code` names the cause.

| Code                    | HTTP  | When                                                                                                          |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND`             | `404` | No such procedure for the caller's role: an unknown name, or an operation the role is not granted             |
| `METHOD_NOT_SUPPORTED`  | `405` | A query sent as `POST`, or a mutation sent as `GET`                                                           |
| `BAD_REQUEST`           | `400` | The input fails the `input` schema, or the batch is over `TRPC_MAX_BATCH_SIZE`                                |
| `UNAUTHORIZED`          | `401` | The role is granted the operation but not what its query reads (`You are not authorized`, REST's `401`)       |
| `TOO_MANY_REQUESTS`     | `429` | The caller is over its [rate limit](./LIMITS.md#request-rate). The response carries `Retry-After`, in seconds |
| `INTERNAL_SERVER_ERROR` | `500` | A hook, a handler or a query threw. The message is always `Internal server error`; the real error is logged   |

A role's router holds only the operations the role is granted, as its GraphQL schema does. An ungranted operation therefore answers exactly as a name that does not exist, whatever the method or the input, so a caller cannot list what it is not granted.

Two more kinds of operation are in the client type and answer `NOT_FOUND` for everyone: one without `rest`, and one named `login`, `logout`, `refresh` or `me` while auth is on (the auth route takes the name, as on REST).

To answer a specific error, throw a `TRPCError` from a hook or a handler: it reaches the client with its code and message. Any other throw is masked, because tRPC would otherwise send its message to the client.

```typescript
import { TRPCError } from "@trpc/server";

throw new TRPCError({ code: "CONFLICT", message: "That title is taken" });
```

## Limits

- **Batching** is on, capped by `TRPC_MAX_BATCH_SIZE`. A batch is one HTTP request and spends one request of the caller's rate limit, like a GraphQL request with several root fields.
- **Queries are `GET` only and mutations `POST` only**: the server does not accept a method override, so a query's input rides the URL.
- **No subscriptions.** Subscriptions stay on the [GraphQL websocket](./SUBSCRIPTIONS.md).
- **No data transformer.** Answers are plain JSON: leave `transformer` unset on the client.
- **An operation named `then`, `call` or `apply`** fails the boot while the surface is on: tRPC reserves the three.

## What is not exposed

- Tables, stored procedures, queues, remote schemas and remote REST proxies.
- The auth routes (`login`, `logout`, `refresh`, `me`): they stay on REST and GraphQL.
- Operations without a `rest` route.

## Observability and audit

Requests to `/trpc/*` are counted and timed under the `route` label `trpc`, and root a trace like the GraphQL and REST routes (see [Observability](./OBSERVABILITY.md)). A streamed batch (`httpBatchStreamLink`) is timed and traced up to its response head: its calls finish after the request's span ends and outside its `trpc` duration. A query operation records its GraphQL operation metric and span as it does over REST. A request that presents the admin secret writes one `admin_secret.used` [audit record](./SECURITY_MODEL.md#audit-log), however many calls it batches.

# Operations

> **See also:** [Configuration](./CONFIGURATION.md) | [Permissions](./PERMISSIONS.md)

Operations are the way you extend Graphoria with custom endpoints. They sit on top of the auto-generated CRUD API: you write a Zod-validated input schema, choose between a declarative GraphQL query or a custom TypeScript handler, and Graphoria registers the endpoint as both a GraphQL field and an OpenAPI-described REST route.

This guide walks through the lifecycle of an operation from declaration to invocation, with examples for the common patterns.

## Two flavours

Every operation is one of two types — they share the same surrounding shape but differ in the body:

- **Query operations** declare a GraphQL `query` string. Graphoria runs it (with input validation, RBAC, hooks, and caching) on each call.
- **Handler operations** declare an async `handler` function. You write the logic in TypeScript and have full access to the database, queue publishers, and your typed repositories.

Both types accept the same surrounding fields: `description`, `input`, `output`, `hooks`, `rest`, `graphql`, `cache`. The difference is whether you supply `query` or `handler`.

## Query operations

The common case — wrap a parameterised GraphQL query into a named operation that the rest of your stack can call without rewriting it.

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ z, operation }) => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    /* … */
  ],
  operations: {
    getOrdersByCustomer: operation({
      description: "List a customer's orders",
      input: z.object({
        customerId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      output: z.object({
        orders: z.array(
          z.object({
            id: z.string(),
            total: z.number(),
            createdAt: z.string(),
          }),
        ),
      }),
      query: `
        query GetOrdersByCustomer($customerId: ID!, $limit: Int!) {
          orders: public_orders(
            where: { customer_id: { eq: $customerId } }
            limit: $limit
            order_by: { created_at: desc }
          ) {
            id
            total
            created_at
          }
        }
      `,
      rest: { path: "/customers/:customerId/orders", method: "GET" },
      cache: { ttl: 30000, max: 1000 },
    }),
  },
})) satisfies ConfigurationFn;
```

When this operation is registered:

- A GraphQL field `getOrdersByCustomer(input: GetOrdersByCustomerInput!)` is added to the unified schema.
- A REST route `GET /rest/customers/:customerId/orders` is exposed; path params and query string are merged into the `input`.
- The result is cached for 30 seconds, with up to 1000 distinct cache entries (LRU eviction).
- The `output` schema is reflected into the OpenAPI spec at `/openapi.json` so SDK generators and API clients see the response shape.

If `output` is omitted, the OpenAPI document marks the response as `unknown`. The `output` schema is purely descriptive — it is not used to validate the response at runtime, since the GraphQL query result already conforms to the schema's types.

## Handler operations

When the work doesn't map cleanly to a single GraphQL query — for example, multi-step orchestration, calls to external services, or fan-out via queues — write a handler:

```typescript
operations: {
  registerUser: operation({
    description: "Register a new user and send a welcome email",
    input: z.object({
      email: z.email(),
      password: z.string().min(8),
      role: z.enum(["user", "admin"]).default("user"),
    }),
    output: z.object({
      userId: z.string(),
      access_token: z.string(),
    }),
    handler: async ({ gqlQuery, queues }, input) => {
      const { data } = await gqlQuery<{ insert_users: { id: string }[] }>(`
        mutation Insert($email: String!, $password: String!, $role: String!) {
          insert_users(objects: [{ email: $email, password: $password, role: $role }]) {
            id
          }
        }
      `, { email: input.email, password: input.password, role: input.role });

      const userId = data.insert_users[0].id;

      queues.events_userRegistered({ userId, email: input.email });

      return { userId, access_token: "stub" };
    },
    rest: { path: "/users", method: "POST" },
  }),
}
```

The handler signature is:

```typescript
type OperationHandler<TInput, TOutput, TRepository> = (
  options: OperationOptions<TRepository>,
  input: TInput,
) => TOutput | Promise<TOutput>;

type OperationOptions<TRepository> = {
  gqlQuery: <TReturn>(
    query: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: TReturn; errors?: unknown[] }>;
  databases: {
    /* raw DB connections, keyed by config name */
  };
  queues: {
    /* publisher functions, keyed by `${queueName}_${publisherKey}` */
  };
  repository: TRepository;
};
```

`gqlQuery` runs queries through the same handler that serves `/graphql`. By default the query executes as the _caller's_ role, so RBAC is preserved. If the operation needs to bypass RBAC, design the underlying tables to allow it directly rather than escalating privileges in the handler.

### Typed repositories

When you define `databases[].repository`, the factory's return type becomes that database's entry in the handler's `options.repository` map (keyed by database name). Pass that map to `operation.typed<{ [dbName]: Repo }>()` to expose the type to the handler:

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

type Repo = {
  ordersByCustomer(customerId: string): Promise<Order[]>;
};

export default (({ operation, z }) => ({
  /* … */
  databases: [
    {
      name: "main",
      type: "pg",
      repository: (sql): Repo => ({
        async ordersByCustomer(customerId) {
          return sql`SELECT * FROM orders WHERE customer_id = ${customerId}`;
        },
      }),
      /* … */
    },
  ],
  operations: {
    listOrders: operation.typed<{ main: Repo }>()({
      input: z.object({ customerId: z.string() }),
      handler: async ({ repository }, input) => {
        return { orders: await repository.main.ordersByCustomer(input.customerId) };
      },
    }),
  },
})) satisfies ConfigurationFn;
```

The handler sees `repository` typed as `{ main: Repo }` — access each database's repository by name (`repository.main`), so refactors stay type-safe.

## REST and GraphQL exposure

By default, every operation is exposed as a GraphQL mutation and (if `rest` is set) as a REST route. Tweak with `graphql` and `rest`:

```typescript
operation({
  /* … */
  graphql: { enabled: true, name: "registerUserMutation" },
  rest: {
    path: "/users",
    method: "POST",
    pathParams: z.object({
      /* schema for path params */
    }),
    queryParams: z.object({ source: z.string() }),
    body: z.object({
      /* override body schema */
    }),
  },
});
```

- `graphql.enabled: false` keeps the operation REST-only — useful for endpoints that need REST semantics (file uploads, webhooks) but don't belong in the GraphQL schema.
- `rest.method` defaults to `GET`. Operations that mutate state should use `POST`/`PUT`/`PATCH` so the OpenAPI spec is honest about their effects.
- `rest.pathParams` / `queryParams` / `body` let you split a single `input` schema across multiple HTTP positions; if omitted, `input` is read from the body for non-GET requests and from the query string for GET.

## Hooks lifecycle

Three optional hooks let you extend an operation without changing its core query/handler:

```typescript
operation({
  /* … */
  hooks: {
    init: async ({ gqlQuery }) => {
      // Runs once on server boot. Return value is cached and passed to beforeRequest.
      return await loadStaticConfig();
    },
    beforeRequest: ({ input }, initData) => {
      // Runs on every request, before the query/handler.
      // Return the (possibly transformed) variables for the query.
      return { ...input, requestedAt: new Date().toISOString() };
    },
    afterRequest: ({ output }) => {
      // Runs after the query/handler succeeds.
      // Return the (possibly transformed) output to send to the client.
      return { ...output, processedAt: new Date().toISOString() };
    },
  },
});
```

`init` is the right place for one-time work: priming a cache, loading static metadata, opening a connection to a third-party service. Its return value is preserved between requests and passed as the second argument to `beforeRequest`.

`beforeRequest` is a transform from the validated `input` to the actual variables (or handler input). Use it to inject server-side context, normalize input, or short-circuit the request by throwing.

`afterRequest` runs only on success. Throw to convert a successful response into an error.

## Caching

```typescript
cache: {
  max: 1000,           // max number of cached entries
  ttl: 60_000,          // ms before an entry is considered stale
  allowStale: true,     // serve stale entries while revalidating
  updateAgeOnGet: true, // bump the TTL on every cache hit
}
```

Caches are LRU and operation-scoped. The cache key is derived from the resolved input — two requests with the same input share the cache entry.

To invalidate a cache from outside the request flow, attach a queue subscriber and call `cache.invalidate(operationName, pattern?)` from its handler. See [Queues](./QUEUES.md) for examples.

## Permissions

Operations participate in RBAC via the `operations` permission key:

```typescript
permissions: {
  user: {
    operations: ["getOrdersByCustomer"],   // explicit allowlist
  },
  admin: {
    operations: "ALL",
  },
}
```

A role missing the operation name from its `operations` list will not see the operation in the GraphQL schema or the REST route table — the REST endpoint returns 404 to that role rather than leaking its existence.

## Calling operations

GraphQL:

```graphql
query {
  getOrdersByCustomer(input: { customerId: "cus_42", limit: 10 }) {
    orders {
      id
      total
      createdAt
    }
  }
}
```

REST:

```bash
curl -H "Authorization: Bearer $TOKEN" \
     'http://localhost:3000/rest/customers/cus_42/orders?limit=10'
```

Path params, query params, and body are zod-validated before the operation runs; validation errors return `400` with a JSON description of the offending fields.

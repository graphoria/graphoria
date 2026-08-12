# Remote GraphQL Schemas

> **See also:** [Remote REST APIs](./REMOTE_REST.md) | [Permissions](./PERMISSIONS.md)

Remote schemas merge external GraphQL APIs into your unified Graphoria endpoint. From the client's perspective, payments, notifications, search, and your own database all sit behind a single `/graphql` URL. Under the hood, Graphoria introspects each remote endpoint at startup, prefixes every type and field to avoid name collisions, and forwards sub-queries to the right upstream at request time.

## When to use it

Reach for remote schemas when:

- You're consolidating several existing GraphQL services behind one API.
- A third-party SaaS exposes a GraphQL endpoint and you'd like its types to flow into the same SDL your app uses.
- You want central RBAC and JWT validation in front of an internal microservice without rewriting it.

If the remote service speaks REST/OpenAPI, see [Remote REST APIs](./REMOTE_REST.md) instead.

## Configuration

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (() => ({
  name: "my-api",
  version: "1.0.0",
  databases: [
    /* … */
  ],
  remoteSchemas: [
    {
      name: "payments",
      url: "https://payments.internal/graphql",
      enabled: true,
      prefix: "payments", // optional, defaults to `${name}_`
      headers: { "X-Service-Token": "abc123" }, // sent on every introspection + proxy request
      forwardHeaders: ["authorization"], // copied from the incoming client request
      timeout: 5000, // milliseconds; default 10000
      introspection: { interval: 0 }, // 0 = introspect once at startup
    },
  ],
})) satisfies ConfigurationFn;
```

| Field                    | Type                      | Notes                                                                                                                                   |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | `string`                  | Unique identifier for this remote, used in permissions and logs.                                                                        |
| `url`                    | `string`                  | The remote GraphQL endpoint that receives both introspection and proxied operations.                                                    |
| `enabled`                | `boolean?`                | Defaults to `true`. Disabled remotes are skipped at startup and produce no SDL.                                                         |
| `prefix`                 | `string?`                 | Prepended (with an underscore) to every remote type and root field. Defaults to `name + "_"`.                                           |
| `headers`                | `Record<string, string>?` | Static headers attached to every request Graphoria sends to this remote.                                                                |
| `forwardHeaders`         | `string[]?`               | Names of headers from the _client_ request to copy into the proxied request. Lowercased; common values: `authorization`, `x-tenant-id`. |
| `timeout`                | `number?`                 | Per-request timeout in ms. Default `10000`.                                                                                             |
| `introspection.interval` | `number?`                 | Re-introspection interval in ms. `0` (default) introspects once at server start.                                                        |

## How prefixing works

If the remote schema declares `type User { id: ID! email: String! }` and the prefix is `payments`, Graphoria rewrites it to:

```graphql
type payments_User {
  id: ID!
  email: String!
}
```

Root `Query` and `Mutation` fields get the same treatment. A remote query named `getUser` becomes `payments_getUser` in the unified schema. Inputs, enums, unions, and interfaces are all prefixed; the bidirectional `PrefixMap` Graphoria builds at startup means the proxy can reverse the rename when it forwards the sub-query, so the remote service still receives the names _it_ knows.

This keeps every cross-service collision impossible by construction. You can stitch in two payment processors that both define `type Customer` without a single hand-written rename.

## Calling a remote field

Querying a remote root field looks identical to querying a local one:

```graphql
query {
  payments_getCustomer(id: "cus_42") {
    id
    email
    payments_recentInvoices(limit: 5) {
      id
      amount
    }
  }
}
```

When this query lands on `/graphql`, Graphoria routes the `payments_*` portions of the selection to the `payments` remote, strips the prefix from each type/field name, and sends a sub-query to `https://payments.internal/graphql`. Aliases in the original query are preserved, so the response shape matches what the client requested without further translation.

Headers behave like this:

1. Static `headers` from the config are always sent.
2. Each header listed in `forwardHeaders` is copied from the incoming client request — typically `authorization` so the remote can apply its own RBAC against the same JWT.
3. Forwarded headers override static headers if both are set.

## Permissions

Remote schemas plug into Graphoria's RBAC. Use the `remoteSchemas` key on a role's permission object:

```typescript
permissions: {
  anonymous: { tables: "ALL" },
  user: {
    tables: { /* … */ },
    remoteSchemas: ["payments"],            // explicit allowlist
  },
  admin: {
    tables: "ALL",
    remoteSchemas: "ALL",                    // every remote
  },
}
```

A role that's missing the remote name from its `remoteSchemas` list won't see those types or root fields in the schema served to that role. The introspection result returned by `/graphql` is filtered per-role, so unauthorized clients can't discover that a remote even exists.

## Operational details

- **Startup behavior**: each enabled remote is introspected in parallel with database introspection. If a remote is unreachable at boot, the server logs the failure and continues — the remote's fields are simply absent from the SDL until you restart with the remote available.
- **Network failures at request time**: a failure (timeout, network error, GraphQL error) is surfaced to the client in the `errors` array of the response. The local part of the query still resolves normally.
- **No subscription support**: remote subscriptions are not currently proxied. Only `query` and `mutation` operations are routed.
- **Schema watching**: `introspection.interval` re-introspects the remote on a timer. Use this for remotes whose schema evolves without coordinated deploys; otherwise leave it at `0` to lock the SDL until the next restart.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Failed to introspect remote schema "<name>"` at startup | The remote is unreachable, returned non-200, or rejected the introspection query. Check `headers`.               |
| Remote field returns `null` with no error                | The proxied request succeeded but the remote returned `null`. Inspect the request from the remote's logs.        |
| Client sees `Unauthorized` on remote field               | `forwardHeaders` doesn't include the auth header your remote expects, or the token was scoped only to Graphoria. |
| Type collision between two remotes                       | Two remotes use the same `prefix`. Each remote needs a unique prefix.                                            |
| Remote schema disappears after restart                   | The remote was unreachable during the last startup. Check the boot logs.                                         |

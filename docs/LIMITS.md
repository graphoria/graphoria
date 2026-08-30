# Resource Limits

> **See also:** [Configuration Reference](./CONFIGURATION.md) | [Security Model](./SECURITY_MODEL.md) | [Operations](./OPERATIONS.md)

Graphoria ships five limits that bound what one caller can ask a database for. This page puts all
five beside each other with their defaults, their environment variables and every way to override
them, because they are otherwise spread across four documents and only make sense together.

They bound **availability, not confidentiality**. None of them keeps a caller from data it is
entitled to; all of them keep one caller from consuming the server. What keeps a caller inside its
own rows is the role's filters — see [Permissions & Access Control](./PERMISSIONS.md) and
[Security Model](./SECURITY_MODEL.md).

This describes the shipped defaults of the current release. Graphoria is pre-1.0 and these values
change with it.

## At a glance

| Limit             | Variable                                      | Default        | Ships   | Override                                                      |
| ----------------- | --------------------------------------------- | -------------- | ------- | ------------------------------------------------------------- |
| Query depth       | `MAX_QUERY_DEPTH`                             | `8`            | **on**  | `AI_MCP_MAX_QUERY_DEPTH` for MCP; `0` disables                |
| Page size         | `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE`         | `100` / `1000` | **on**  | per-field `limit` / `offset`; `0` on either opts out          |
| Statement timeout | `QUERY_TIMEOUT_MS`                            | `10000`        | **on**  | per-operation `timeout`; MSSQL `requestTimeout`; `0` disables |
| Request rate      | `RATE_LIMIT_MAX` / `RATE_LIMIT_ANONYMOUS_MAX` | `0`            | **off** | per-role `rateLimit`; `RATE_LIMIT_WINDOW_MS` moves the window |
| Query cost        | `MAX_QUERY_COST`                              | `0`            | **off** | none — one global budget                                      |

**Operator-authored queries are exempt from depth, page size and cost.** REST operations, cron jobs
and the query function handed to operation hooks take their text from the configuration, never from
a caller, so a limit there could only reject the operator's own intent. The statement timeout is not
exempted — it protects the database from a slow query whoever wrote it.

## Two of the five ship off

`RATE_LIMIT_MAX` and `MAX_QUERY_COST` both default to `0`, which means off. **Neither warns at boot.**
A deployment that sets nothing gets three of the five limits, and nothing in the logs says which two
are missing.

The other three warn when you turn them off — `MAX_QUERY_DEPTH=0` and `QUERY_TIMEOUT_MS=0` each log a
warning at startup, because for those `0` is a deliberate opt-out from a default that was on. There
is no equivalent for the two that were never on, since the warning would fire for every deployment on
every boot.

Read this section as that warning. Setting `RATE_LIMIT_MAX` is the single highest-value change an
operator can make to a default deployment: until it is set, nothing in the product slows repeated
password guesses against `auth_login` or the console login endpoint.

One asymmetry worth knowing: `DEFAULT_PAGE_SIZE=0` and `MAX_PAGE_SIZE=0` also opt out silently. They
are bounds rather than toggles, so `0` reads as "no bound" rather than "disabled", and no warning
fires for either.

## Query depth

`MAX_QUERY_DEPTH` rejects a caller's query that nests deeper than it, before execution. It defaults
to `8`. `0` disables it and logs a warning at boot.

Depth is what stops nested-selection blowup: relationship resolvers are generated, so a caller can
follow `user → posts → author → posts` for as long as the schema allows, and each level multiplies
the work. The bound is a validation rule on the parsed document, so it costs nothing at execution and reaches
every path that takes a query from a caller: `/graphql` over HTTP, the websocket subscription
handshake, `/mcp`, `/ai` and the in-process `execute`. They all validate through the same role
handler, so the one default covers them without per-path wiring.

Over the limit answers a validation error naming both numbers:

```
Query depth of 12 exceeds the maximum allowed depth of 8 (operation: "Feed"). Raise MAX_QUERY_DEPTH to allow deeper queries.
```

**`AI_MCP_MAX_QUERY_DEPTH` overrides it for the MCP endpoint only.** An agent exploring a schema
legitimately writes deeper queries than an application does. Unset, MCP runs on `MAX_QUERY_DEPTH`;
set, it replaces that value for `/mcp` and `/ai` rather than being capped by it, so it can be raised
as well as lowered. See [MCP Server](./MCP.md).

## Page size

`DEFAULT_PAGE_SIZE` is the page a list field gets when it asks for no `limit`, defaulting to `100`.
`MAX_PAGE_SIZE` rejects a field asking for more than it, defaulting to `1000`. Either takes `0` to
opt out — `DEFAULT_PAGE_SIZE=0` leaves an unbounded field unbounded, `MAX_PAGE_SIZE=0` removes the
ceiling.

Both apply **at every nesting level**, not only the root. Nested to-many relationships take `limit`
and `offset` arguments of their own and carry the same default, so a nested list cannot be used to
sidestep the bound the root field respects.

Asking for more than the ceiling is a rejection, not a silent truncation — a caller that asked for
5000 rows and quietly received 1000 would have no way to know its page was incomplete:

```
Requested page size of 5000 exceeds the maximum allowed page size of 1000 (field: "public_users"). Raise MAX_PAGE_SIZE to allow larger pages.
```

The override is per field: pass `limit` up to the ceiling.

```graphql
query {
  public_users(limit: 500) {
    id
    posts(limit: 20, offset: 40) {
      id
    }
  }
}
```

**One gap.** `_aggregate { items }` returns before pagination is applied, so `items` inside a grouped
aggregate is unbounded regardless of `MAX_PAGE_SIZE`. Open, availability only; see
[Security Model](./SECURITY_MODEL.md#_aggregate--items--takes-no-page-bound).

## Statement timeout

`QUERY_TIMEOUT_MS` aborts a statement that has run longer than it, in milliseconds, defaulting to
`10000`. `0` disables it and logs a warning at boot.

The bound is applied **by the database**, not by the client. That distinction is the whole point: a
client that merely gave up waiting would still be holding the connection and every lock the statement
had taken.

Each engine enforces it the only way it can:

| Engine  | Mechanism                                                       | Covers                                                        |
| ------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| `pg`    | `statement_timeout`, set on every connection in the pool        | every statement, generated queries and auth and introspection |
| `mssql` | `requestTimeout` on the pool, an attention packet when it fires | every request                                                 |
| `mysql` | a `MAX_EXECUTION_TIME` hint on the generated statement          | generated read queries only                                   |

**MySQL is bounded only where the hint reaches.** Bun's MySQL adapter offers no hook to run a setting
when a pooled connection opens, so there is no pool-level route on that engine, and auth logins,
schema introspection and stored-procedure `CALL`s are not bounded there. They are on `pg` and `mssql`.
Open gap; see [Security Model](./SECURITY_MODEL.md#mysql-bounds-fewer-statements-than-the-other-two-engines).

Two overrides, in precedence order:

1. **Per operation.** An operation's `timeout` beats everything else for that operation, in
   milliseconds. See [Operations](./OPERATIONS.md#statement-timeout).
2. **Per MSSQL pool.** `connectionOptions.requestTimeout` wins over `QUERY_TIMEOUT_MS` when you set
   it explicitly — the env value only fills it in when the key is absent — so a pool deliberately
   raised for a slow report keeps its bound. Note the units differ: `requestTimeout` is in **seconds**,
   `QUERY_TIMEOUT_MS` in milliseconds.

## Request rate

Off by default. `RATE_LIMIT_MAX` is the request ceiling per window for an authenticated caller and
`RATE_LIMIT_ANONYMOUS_MAX` the same for the anonymous role; both default to `0`, which is off.
`RATE_LIMIT_WINDOW_MS` sets the window, defaulting to `60000`.

| Variable                   | Type      | Default | Notes                                          |
| -------------------------- | --------- | ------- | ---------------------------------------------- |
| `RATE_LIMIT_MAX`           | `number`  | `0`     | Requests per window, authenticated. `0` is off |
| `RATE_LIMIT_ANONYMOUS_MAX` | `number`  | `0`     | Same, anonymous role. `0` is off               |
| `RATE_LIMIT_WINDOW_MS`     | `number`  | `60000` | Window length in milliseconds                  |
| `RATE_LIMIT_TRUST_PROXY`   | `boolean` | `false` | Read the client address from `X-Forwarded-For` |

A caller gets **one bucket across every endpoint** — `/graphql` including the websocket upgrade,
`/rest/*`, `/ai`, `/mcp` and the console login — because what exhausts a server is total request
volume, not volume on one route. An idle bucket refills to `max`, so a caller may burst `max` then
sustain `max` per window. Over budget is `429` with `Retry-After` in seconds.

Callers are identified by authenticated subject where there is one and by client address otherwise.
**Neither the admin secret nor the superadmin role is exempt**, so set `RATE_LIMIT_MAX` above what
your own tooling needs — the console alone polls status every five seconds.

The override is per role, and it beats both environment values:

```typescript
auth: {
  permissions: {
    anonymous: { tables: "ALL", rateLimit: { max: 60 } },
    admin: { tables: "ALL", rateLimit: { max: 600, windowMs: 10000 } },
  },
}
```

Resolution runs role config → `RATE_LIMIT_ANONYMOUS_MAX` for the anonymous role → `RATE_LIMIT_MAX`.
A role entry works while both environment values are `0`, which is how you throttle anonymous callers
and nobody else. `max: 0` on a role opts that role out.

Four things to know before relying on it, all covered in full under
[Rate limiting](./CONFIGURATION.md#rate-limiting):

- **The store follows `CACHE_STORE`.** With `redis` every worker shares one bucket; with `memory`
  each worker keeps its own, so **the effective limit in cluster mode is your ceiling times the
  worker count**. Redis is the correct configuration for cluster mode, and is never required.
- **A Redis outage fails open**, with one warning per window. The alternative turns a cache blip into
  an outage.
- **`RATE_LIMIT_TRUST_PROXY` is only as trustworthy as the proxy.** On a directly-exposed server it
  makes the limit decorative, since the caller sets the header.
- **It does nothing about a distributed flood.** Per-caller buckets slow one host, not a botnet.

## Query cost

Off by default. `MAX_QUERY_COST` caps the estimated cost of a caller's query and rejects it before it
executes. `0`, the default, means nothing is estimated.

It exists because depth and page size leave one shape uncovered. Depth bounds how deep a selection
nests and `MAX_PAGE_SIZE` bounds a single list field; a query that is merely **wide** passes both. A
hundred sibling relationships under one root list, each paged at the default, is a legal eight-deep
query asking for a million rows.

The estimate walks the parsed document against the role's schema:

```
cost(field) = 1 + multiplier(field) × Σ cost(child)
```

`multiplier` is the page size a list field asks for — its `limit`, resolved through the request's
variables, falling back to `DEFAULT_PAGE_SIZE` — and `1` for anything returning a single row.
Fragment spreads are expanded, so moving a fan-out into a fragment does not hide it, and a document
with several operations is scored by its most expensive one.

At the default `DEFAULT_PAGE_SIZE` of `100`:

| Query                                                  | Cost         |
| ------------------------------------------------------ | ------------ |
| `tasks(limit: 20) { id title project { id name } }`    | `101`        |
| A dashboard: one unbounded root list, seven scalars    | `701`        |
| Three unbounded nested to-many lists, one scalar each  | `1 020 201`  |
| One root list × 1000 to-many siblings, one scalar each | `10 100 001` |

**`100000` is the recommended starting value.** Four orders of magnitude separate a realistic query
from a wide one, which is what makes a single scalar budget workable: it clears both realistic rows
above with room to spare and rejects both attack shapes.

Over budget answers a validation error naming both numbers:

```
Estimated query cost of 1020201 exceeds the maximum allowed cost of 100000 (operation: "Dashboard"). Raise MAX_QUERY_COST to allow more expensive queries.
```

There is **no per-role or per-endpoint override** — one global budget. MCP gets its own depth knob
because an agent legitimately writes deeper queries than an application does; nothing makes the same
argument for asking a database for more rows, so `/mcp` and `/ai` are scored against the same budget
as any other caller. Full derivation, including the one legitimate query shape it rejects, is under
[Bounding how much one query asks for](./CONFIGURATION.md#bounding-how-much-one-query-asks-for).

## Connection pool bounds

Not one of the five, but the same failure they defend against arrives through the pool. A database
connection is the scarcest resource in the process, and every limit above is partly a way of not
holding one.

`connectionOptions` on a database sets the bounds. **All of its timeout values are in seconds**,
unlike `QUERY_TIMEOUT_MS`. Omit the key and the defaults below apply; omit an individual field and
that field's default applies.

| Option                             | Engines       | Default            | Bounds                              |
| ---------------------------------- | ------------- | ------------------ | ----------------------------------- |
| `max` / `pool.max`                 | all           | `10`               | Connections in the pool             |
| `idleTimeout` / `pool.idleTimeout` | all           | `30`               | How long an idle connection is kept |
| `connectionTimeout`                | all           | `30`               | Waiting to **open** a connection    |
| `maxLifetime`                      | `pg`, `mysql` | `3600`             | Total lifetime of a connection      |
| `pool.acquireTimeout`              | `mssql` only  | `30`               | Waiting for a **free** connection   |
| `requestTimeout`                   | `mssql` only  | `QUERY_TIMEOUT_MS` | One request                         |

MSSQL nests the pool bounds under `pool`; `pg` and `mysql` take them at the top level.
`requestTimeout` is the one field whose default comes from elsewhere — `QUERY_TIMEOUT_MS`, converted
to seconds — so an MSSQL pool inherits the statement timeout unless it names its own.

**`acquireTimeout` is MSSQL only.** Bun's SQL client, which backs `pg` and `mysql`, exposes no
equivalent — its `connectionTimeout` bounds opening a connection, not waiting for one. So on those
two engines a slow-query storm queues callers rather than failing them. The statement timeout is what
keeps that queue draining. See
[ConnectionOptions](./CONFIGURATION.md#connectionoptions).

## Configuring for production

A deployment that changes nothing runs with depth, page size and statement timeout on. Two changes
close the gap:

```bash
# The single highest-value change to a default deployment.
RATE_LIMIT_MAX=600
RATE_LIMIT_ANONYMOUS_MAX=60

# The wide-query budget. 100000 clears realistic queries by two orders of magnitude.
MAX_QUERY_COST=100000
```

Then, if you run in cluster mode, set `CACHE_STORE=redis` so the rate limit is one bucket rather than
one per worker.

Raise rather than disable. Every one of these takes `0` to opt out, and `0` on any of them returns
the deployment to the shape the limit was added to prevent. If a legitimate query is rejected, the
error names the number to raise.

See the [Production Checklist](../README.md#production-checklist) for the rest of what a deployment
owes beyond limits.

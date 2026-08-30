# Security Model

> **See also:** [Permissions & Access Control](./PERMISSIONS.md) | [Authentication](./AUTHENTICATION.md) | [Security Policy](../SECURITY.md)

Graphoria generates an API over a database. That places it directly between untrusted clients and
the data, so what it does and does not defend is worth stating plainly rather than leaving to be
inferred from the configuration reference.

This document describes the shipped defaults of the current release. It is a description, not a
promise: where a defence exists, the test that holds it up is named; where one does not, it is
listed under [What is not defended](#what-is-not-defended) rather than left out. Graphoria is
pre-1.0 and this document changes with it.

## Trust boundaries

There is one boundary that matters, and it runs between the caller and the role its credential
resolves to. Everything on the caller's side is untrusted: the GraphQL document, its variables, the
REST path and query string, the token and every claim inside it. Everything on the operator's side
is trusted: `graphoria.ts`, the environment, and the database itself.

That second half is not a defence, it is a definition. Configuration is executed, not sandboxed —
an operation's `query`, a virtual column's SQL expression, a table or schema name, and a handler's
code all run with the privileges of the database user Graphoria connects as. An attacker who can
edit the configuration has already won, and no check in the product is placed to stop them. Treat
`graphoria.ts` with the same care as application source.

### Who a caller can be

| Caller             | Identified by                                          | Resolves to                              | Reaches                                                                             |
| ------------------ | ------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Anonymous          | nothing                                                | `ANONYMOUS_ROLE` (default `anonymous`)   | That role's compiled schema, and nothing else                                       |
| Authenticated user | `Authorization: Bearer <token>`, audience `access`     | the token's `role` claim                 | That role's compiled schema, rows narrowed by the role's filter and its own session |
| Administrator      | `x-admin-secret: <ADMIN_SECRET>`                       | `SUPERADMIN_ROLE` (default `superadmin`) | Everything. RBAC is bypassed, not widened                                           |
| Console operator   | `graphoria_console_session` cookie, audience `console` | the console's own session                | `{console}/api/*` only                                                              |
| MCP client         | nothing, unless `AI_MCP_REQUIRE_ADMIN_SECRET=true`     | the anonymous role                       | The anonymous role's schema through the MCP tools                                   |
| AI agent caller    | `x-admin-secret`                                       | `superadmin`                             | Every table, through a model                                                        |
| Subscriber         | token presented once in `connection_init`              | the token's `role` claim                 | That role's subscription root                                                       |

Two properties of that table are easy to miss and are deliberate.

**An unusable token is anonymous, not an error.** A missing, malformed, expired, wrongly-audienced or
revoked bearer token resolves to the anonymous role and the request proceeds. Callers do not receive
`401` for a bad token; they receive whatever the anonymous role can see, which in a correctly
configured deployment is little or nothing. Clients that need to distinguish "logged out" from
"allowed" must check the response, not the status code.

**Anonymous is a real role with a real schema.** If `permissions.anonymous.tables` is `"ALL"`, every
table is readable without a credential. The default configuration in the quickstart is permissive
because it is a quickstart. Narrow it before exposing a port.

## What the admin secret grants

`ADMIN_SECRET` is required at boot — the server does not start without it — and it is the single
credential that bypasses role-based access control entirely. Presenting it in the
`x-admin-secret` header resolves the request to the superadmin role, whose schema is compiled from
every table, stored procedure, operation, queue and remote source the configuration knows about,
with no row filter and no column restriction.

It also gates, at the same strength:

- `POST {console}/api/login`, which exchanges it for a console session cookie.
- `POST /ai`, the natural-language agent, which is bound to the superadmin schema.
- `POST /mcp`, but only when `AI_MCP_REQUIRE_ADMIN_SECRET=true`. It is `false` by default.

Comparison is `crypto.timingSafeEqual` on every path, and a blank secret never matches. There is one
secret, it does not expire, it cannot be scoped, and rotating it requires restarting every process
that holds it. Treat it as a break-glass credential: it belongs in a secret manager and behind
network-level protection, not in a client.

## What a valid low-privilege token reaches

Role-based access control in Graphoria is not a check performed at request time. Each role gets its
own `GraphQLSchema`, compiled at boot from that role's permissions, and the request handler is
handed the schema for the caller's role and nothing else. A table a role was not granted is not
refused — it does not exist in that role's schema, and a query naming it fails the same way a query
naming a typo does.

On top of that, three narrowings apply to what remains:

- **Row filters.** `permissions.<role>.tables.<table>.filter` becomes a `WHERE` clause on every read
  of that table, at the root, through a relationship at any depth, inside an aggregate, and on a
  subscription. `$session.*` placeholders resolve from the caller's own token — `$session.sub` for
  the subject, `$session.claims.<name>` for a custom claim — and are bound as parameters, never
  interpolated.
- **Column lists.** A column outside `columns` is absent from every generated type, and cannot be
  selected, filtered on, or ordered by.
- **Resource grants.** Stored procedures, operations, queues, remote schemas and remote REST APIs
  are each granted per role and absent otherwise.

A token carrying a role the configuration never defines reads nothing. It does not fall back to
anonymous, and it does not inherit another role's schema.

## Claims, and the tests behind them

Every claim below is held up by integration tests that run against real PostgreSQL, MySQL and SQL
Server instances — not mocks — on a two-tenant fixture where one tenant's rows appearing in the
other's response is the failure condition. The suites live in
`packages/server/src/__test/integration/rls/` and run with `bun run test:integration`.

Sixty cases per engine, one hundred and eighty in total. Each is listed against the claim it holds.

### C1 — A role's row filter reaches every read of the table

Not only the root field. The classic bypass is reaching a filtered table through a relationship, an
aggregate, or a fragment, and each of those is asserted separately.

| Test (`escape.test.ts` unless noted)                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- |
| filters the root list to the caller's own rows                                                                       |
| resolves a string-valued role filter to the caller's own row                                                         |
| applies the filter to a table reached through a relationship                                                         |
| applies the filter two relationship levels deep                                                                      |
| applies the filter when traversing backwards from a task                                                             |
| applies the filter through the self-referential relationship                                                         |
| applies the filter to the `_single` field                                                                            |
| counts only visible rows in an aggregate                                                                             |
| does not leak other tenants through a grouped aggregate                                                              |
| does not leak another tenant's values through min/max                                                                |
| never returns another tenant's rows through a named fragment                                                         |
| never returns another tenant's rows through an inline fragment                                                       |
| applies the filter to every alias of a restricted field                                                              |
| applies the filter to a field carrying transform directives                                                          |
| applies the filter to a query using the `@when` directive                                                            |
| shows each tenant only its own rows for the same query                                                               |
| sees both tenants as admin (`fixture.test.ts`) — the control that distinguishes a working filter from an empty table |

### C2 — A caller-supplied argument cannot widen a row filter

The role filter and the caller's `where` are combined, never substituted.

| Test (`escape.test.ts`)                                      |
| ------------------------------------------------------------ |
| does not let a contradicting where widen the role filter     |
| does not let an `in` list reach another tenant's rows        |
| does not let a variable-supplied where widen the role filter |

### C3 — A withheld column cannot be read sideways

Selecting a column is not the only way to learn its value. Filtering on it is a boolean oracle;
ordering by it leaks the value through row order without ever returning it.

| Test (`escape.test.ts`)                                |
| ------------------------------------------------------ |
| refuses to filter on a column the role cannot select   |
| refuses to order by a column the role cannot select    |
| does not expose a withheld column in the role's schema |

### C4 — What a role was not granted is absent, not refused

Absence rather than refusal matters: a field that exists but answers "unauthorized" confirms it
exists.

| Test                                                                                                 |
| ---------------------------------------------------------------------------------------------------- |
| keeps restricted tables out of the anonymous schema entirely (`escape`)                              |
| refuses an anonymous query for a restricted table (`escape`)                                         |
| keeps a stored procedure out of a role that was not granted it (`escape`)                            |
| keeps a restricted table out of the anonymous subscription root (`escape`)                           |
| gives the anonymous role a schema holding only the table it may read (`schema-isolation`)            |
| leaves no trace of a restricted table anywhere in the anonymous introspection (`schema-isolation`)   |
| rejects a restricted root field as unknown, not as unauthorized (`schema-isolation`)                 |
| omits the columns a role's permission withholds from every type built from them (`schema-isolation`) |
| keeps those same columns for a role that may read them (`schema-isolation`)                          |
| drops relationships that would reach a table the role was not granted (`schema-isolation`)           |
| exposes stored procedures only to the role granted them (`schema-isolation`)                         |
| compiles every role's schema as a subset of the unfiltered one (`schema-isolation`)                  |

### C5 — An unresolvable session variable fails closed

A filter naming a claim the token does not carry produces an error. It does not silently drop the
filter, which would return the whole table.

| Test (`escape.test.ts`)                                           |
| ----------------------------------------------------------------- |
| fails closed when a filter names a claim the token does not carry |

### C6 — Array-valued claims scope rows

The `{ in: "$session.claims.<array>" }` pattern resolves to the caller's own list.

| Test (`escape.test.ts`)       |
| ----------------------------- |
| scopes rows by an array claim |

### C7 — An undefined role reads nothing

| Test (`schema-isolation.test.ts`)                                         |
| ------------------------------------------------------------------------- |
| reads nothing for a token carrying a role the configuration never defined |

### C8 — No cache entry crosses a caller or a role

Graphoria caches REST operation responses and per-role query analysis. A cache keyed too loosely is
a cross-tenant leak that is invisible in the query builder, so each key is asserted directly, from a
primed cache.

| Test (`schema-isolation.test.ts`)                                        |
| ------------------------------------------------------------------------ |
| serves the cached route from the cache on a repeat request — the control |
| does not serve one user's cached rows to another user in the same role   |
| does not serve a user's cached rows to a different role                  |
| does not route a cached operation to a role that was not granted it      |
| does not serve one caller's cached query analysis to another             |

### C9 — A subscriber is pushed only rows it may read

A table subscription is a query that repeats, and the row filter reaches its pushed rows the same
way it reaches a response. Subscribers asking for the identical document share one poller, and that
sharing is scoped to the caller: role, subject, arguments and selections all take part in the group
key, so two callers are served the same rows only when they asked the same question as the same
person.

| Test (`escape.test.ts`)                                                     |
| --------------------------------------------------------------------------- |
| delivers only the caller's own rows to a database subscription              |
| never serves one session's subscription rows to another session             |
| never serves a subscription's rows to a caller who asked for different ones |

This is the newest of the claims here and it did not hold when it was first measured. See
[Queue subscriptions](#queue-subscriptions-are-not-row-filtered) below for the part of the
subscription surface it does not cover.

### C10 — No caller-supplied value or identifier changes what a statement means

Values are bound as parameters; identifiers cannot be spelled at all, because every column and table
name a caller can name is an enum of real ones. Each case asserts three things — no SQL error, no
unexpected row, and no schema change — the last because a payload that returns nothing and drops a
table has still succeeded.

| Test (`injection.test.ts`)                                              |
| ----------------------------------------------------------------------- |
| survives metacharacters in an eq value                                  |
| survives metacharacters in a like pattern                               |
| survives metacharacters inside an in list                               |
| survives metacharacters in a neq value, which must not widen the result |
| rejects an order_by column that is not a real column                    |
| rejects a selected field that is not a real column                      |
| survives hostile pagination values                                      |
| survives metacharacters in a directive argument                         |
| survives a session claim carrying metacharacters                        |
| survives metacharacters in a REST path parameter                        |
| survives metacharacters in a REST query parameter                       |
| survives generated metacharacter strings                                |
| survives generated metacharacter strings in a like pattern              |

The session-claim case is the one worth dwelling on: a JWT claim is attacker-influenced wherever
users can change their own profile, and the role filter interpolates `$session.*`. The fixture
therefore includes a user whose username is `x' OR '1'='1`.

### C11 — Passwords are verified, not compared

Login runs argon2id through Bun's password APIs. The fixture logs every user in through the real
auth mutation rather than minting tokens directly, so the login path is exercised by every suite
above.

| Test (`fixture.test.ts`)             |
| ------------------------------------ |
| mints a token for every fixture user |

## Resource limits

These bound availability, not confidentiality. None of them keeps a caller from data it is entitled
to; all of them keep one caller from consuming the server.

| Limit             | Setting                                      | Default        | What it bounds                                 |
| ----------------- | -------------------------------------------- | -------------- | ---------------------------------------------- |
| Query depth       | `MAX_QUERY_DEPTH`                            | `8`            | Nested-selection blowup. `0` disables it       |
| Page size         | `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE`        | `100` / `1000` | Rows per list field, at every nesting level    |
| Statement timeout | `QUERY_TIMEOUT_MS`, per-operation `timeout`  | `10000`        | How long one statement may hold a connection   |
| Request rate      | `RATE_LIMIT_MAX`, `RATE_LIMIT_ANONYMOUS_MAX` | `0` — **off**  | Requests per `RATE_LIMIT_WINDOW_MS` per caller |
| Query cost        | `MAX_QUERY_COST`                             | `0` — **off**  | Estimated rows one query asks a database for   |

Operator-authored queries are exempt from the depth, page and cost limits: REST operations, cron
jobs and the query function handed to operation hooks take their text from the configuration, never
from a caller, so a limit there could only reject the operator's own intent.

**The query cost budget ships off too.** Depth bounds how deep a query nests and the page size
bounds one list field; neither bounds a query that is merely wide — a hundred sibling relationships,
each paged, is a legal eight-deep query. `MAX_QUERY_COST` is the limit that catches that shape, and
until it is set nothing does. See
[Bounding how much one query asks for](./CONFIGURATION.md#bounding-how-much-one-query-asks-for).

**The rate limit ships off.** Until it is configured there is nothing in the product that slows
repeated requests — including repeated password guesses against `auth_login` and against the console
login endpoint. Configuring it is the single highest-value change an operator can make to a default
deployment. See [Rate limiting](./CONFIGURATION.md#rate-limiting).

## What is not defended

Everything in this section is known, and none of it is fixed by an upgrade. Each entry is either a
deliberate trade or an open gap, and it says which.

### The admin secret is one credential with no scope and no rotation

Enabling the console grants, to the same secret, the ability to read every table through `/ai`.
There is no console-read credential distinct from an AI credential, and no way to rotate the secret
without a restart. **Open gap.** Until it closes, the mitigation is network-level: do not expose the
console, `/ai` or `/mcp` to the internet.

### The AI agent runs as superadmin

`POST /ai` is bound to the superadmin schema, so a prompt is evaluated against every table in the
database with no row filter. It is gated by the admin secret and disabled by default. **Deliberate**
— the agent's purpose is to answer questions across the whole database — but it means prompt
injection against that endpoint is a read of everything. Do not put untrusted text into it.

### The MCP endpoint is unauthenticated by default

When `ai.mcp.enabled` is on, `AI_MCP_REQUIRE_ADMIN_SECRET` defaults to `false`, so anyone who can
reach the port can call the MCP tools. They run against the **anonymous** role's schema, so the
blast radius is exactly what an anonymous caller could already read over `/graphql` — but that is
the whole radius only if the anonymous role is narrow. Set `AI_MCP_REQUIRE_ADMIN_SECRET=true`, or
keep the anonymous role empty.

### `rest_execute` permits writes

The MCP tool set includes `rest_execute`, which accepts `POST`, `PUT`, `PATCH` and `DELETE` against
the anonymous-role REST handler. It is therefore not a read-only surface, whatever the anonymous
role has been granted. **Deliberate**, and disableable: `AI_MCP_DISABLED_TOOLS=rest_execute`.

### `/openapi.json` is public and describes the superadmin surface

The OpenAPI document is generated from the superadmin schema and served without authentication, a
rate limit, or an off-switch. It carries no rows, but it names every operation, its path, and its
input and output schema, including remote REST proxies. `/graphiql` and `/scalar` are likewise
unauthenticated, though the introspection they perform is per-role and reveals nothing extra.
**Open gap.** Put the three paths behind a gateway rule if the surface itself is sensitive; their
paths are configurable through `OPENAPI_ENDPOINT`, `GRAPHIQL_ENDPOINT` and `SCALAR_ENDPOINT`.

### Queue subscriptions are not row-filtered

A queue-backed subscription delivers the broker message, not a row Graphoria read, so there is no
filter to apply to it. Access is per role through `permissions.<role>.queues`, and every subscriber
granted the queue receives the entire message. **Deliberate**, and a real constraint on what may be
published: do not put data into a queue that fans out to a role which may not read all of it.

### A subscription's authorization is captured once

The token arrives in `connection_init` and the resulting session is held for the life of the socket.
A token that expires or is revoked mid-stream does not interrupt subscriptions already running.
Clients must reconnect to re-authenticate. **Deliberate**; shorten `JWT_EXPIRES_IN` if the window
matters.

### `_aggregate { items }` takes no page bound

The grouped-aggregate path returns before pagination is applied, so `items` inside an aggregate is
unbounded regardless of `MAX_PAGE_SIZE`. **Open gap**, availability only.

### MySQL bounds fewer statements than the other two engines

`QUERY_TIMEOUT_MS` reaches the connection pool on PostgreSQL and SQL Server, so every statement they
run is bounded. On MySQL there is no pool-level route — Bun's adapter exposes no per-connection init
hook — so the bound rides in the SQL text as a `MAX_EXECUTION_TIME` optimiser hint on the outermost
`SELECT`. Generated read queries are covered; a stored-procedure `CALL`, an auth query, and
introspection are not. **Open gap**, documented rather than closed because the alternative is a
pinned connection and an extra round trip on every query.

### Console logout binds one worker

Console session revocation is held in the process that served the logout. In cluster mode a
logged-out cookie remains valid on other workers until it expires on its own, which is why
`CONSOLE_SESSION_EXPIRES_IN` defaults to one hour. **Deliberate** — backing revocation with the
Redis JTI store would make a dead cache take the console down.

### The in-memory rate limiter does not span workers

With `CACHE_STORE=redis` the limiter is shared and cluster-correct. Otherwise each worker keeps its
own buckets, so the effective limit is the configured one multiplied by the worker count.
**Deliberate**; set `CACHE_STORE=redis` in cluster mode.

### Two deployments sharing one Redis can serve each other's rows

The REST response cache key hashes the pathname, method, variables, `sub` and `role`. Nothing in it
names the deployment, the database or the configuration. Two Graphoria servers pointed at the same
Redis, with an operation of the same name, will serve each other's cached rows to a caller whose
`role` and `sub` match. **Open gap.** Give each deployment its own Redis database or its own Redis.

### `AI_GRAPHQL_ENABLED` does nothing

The variable parses and is then read by nothing. An operator who sets it to `false` believing
GraphQL execution is disabled for the AI agent has changed nothing. **Open gap.** Use
`AI_MCP_DISABLED_TOOLS` for the MCP surface; there is currently no switch for the agent's own tools.

### Failure directions, where they differ

Two subsystems fail in deliberately opposite directions, and the asymmetry is intentional. Token
revocation **fails closed**: if the JTI store is unreachable, every token is treated as revoked and
callers drop to the anonymous role. The rate limiter **fails open**: if its Redis is unreachable,
requests are allowed and a throttled warning is logged. A confidentiality control that cannot check
must refuse; an availability control that cannot check must not become the outage.

## Out of scope

Graphoria does not attempt to defend these, and configuring it carefully will not change that:

- **Transport security.** There is no TLS termination in the server. Run it behind a proxy that has
  one. The console session cookie is `Secure`, so a console reached over plain HTTP on a non-local
  address will not work at all — that is the intended failure.
- **Network-level denial of service.** The rate limiter bounds a caller, not a botnet.
- **Database hardening.** Graphoria connects as one database user and inherits its privileges.
  Granting that user less is the operator's control, and the most effective one available: a
  connection that cannot `DROP` cannot be made to.
- **Supply chain of the deployment.** Dependencies are scanned in CI and images are the operator's.
- **The configuration author.** See [Trust boundaries](#trust-boundaries).

## Reporting

Found something this document says is defended, and it is not? That is a vulnerability, and
[SECURITY.md](../SECURITY.md) is how to report it privately. Please do not open a public issue.

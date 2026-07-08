# Taskly — a feature tour of Graphoria

Taskly is a **multi-tenant team task tracker** built to exercise (nearly) every
Graphoria feature on a **single PostgreSQL database**. Two tenants — _Acme_ and
_Globex_ — share one schema; row-level RBAC keeps them apart.

**Ready to go.** Clone, `docker compose up`, `bun run index.ts` — you're live with
a full GraphQL + REST API backed by your own database in minutes. Every feature
below is exercised by this single runnable project.

This folder is a runnable, documented example:

| File                                 | What it is                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`graphoria.ts`](./graphoria.ts)     | The full assembled configuration — every feature wired up.                                  |
| [`seed.pg.sql`](./seed.pg.sql)       | Schema (real FKs, except `task_tags`), the virtual-column function, stored proc, seed rows. |
| [`seed.mssql.sql`](./seed.mssql.sql) | The same schema + seed ported to SQL Server (dialect notes in the file header).             |
| [`seed.mysql.sql`](./seed.mysql.sql) | The same schema + seed ported to MySQL (dialect notes in the file header).                  |
| [`index.ts`](./index.ts)             | The entry point — mounts Graphoria's handlers (`createHandlers`) and serves the frontend.   |
| [`fe/`](./fe)                        | React + urql frontend (login → task dashboard), served at `/`.                              |

The sections below are a tour: each feature points at the part of
[`graphoria.ts`](./graphoria.ts) (or [`seed.pg.sql`](./seed.pg.sql)) that turns it on,
and shows how to exercise it.

> **One Postgres caveat.** The only features Taskly can't show are the
> MSSQL-only virtual-column helpers (`createOneToBooleanMSSQL`,
> `createYAndNToBooleanMSSQL`) and the SQL-Server branches of `@pad` / `@dateFormat`
> / `@ceil`. Everything else runs on Postgres alone.

---

## 1. Services

All backing services come from the repo's [`examples/docker-compose.yml`](../docker-compose.yml),
exposed on localhost:

| Service  | Port(s)     | Used for                                    |
| -------- | ----------- | ------------------------------------------- |
| Postgres | 5432        | the `taskly` database Graphoria introspects |
| Redis    | 6379        | auth refresh-token store + operation cache  |
| RabbitMQ | 5672, 15672 | queues, publishers, GraphQL subscriptions   |

```bash
docker compose -f ../docker-compose.yml up -d
```

Taskly connects straight to the compose Postgres' default `my_app` database
(`postgres` / `postgrespassword`) — the connection is hard-coded in
[`graphoria.ts`](./graphoria.ts) under `databases[0].connection`, so there's no
separate database to create.

---

## 2. The database

[`seed.pg.sql`](./seed.pg.sql) creates the tables, the `task_age_days` function (backs
a virtual column), the `project_stats` stored procedure, and seed rows for both
tenants. You don't apply it by hand — the database's `onConnect` hook in
[`graphoria.ts`](./graphoria.ts) runs it inside a transaction on every boot, and
every statement is idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`) so
restarts never clash.

Tables: `organizations`, `projects`, `tasks`, `comments`, `tags`, `task_tags`,
`audit_log`. Most relationships are **real foreign keys** — Graphoria introspects
them into the generated API graph automatically. The exception is `task_tags`,
which carries no FKs; its relationships are declared in
[`graphoria.ts`](./graphoria.ts) instead (see [Relationships](#relationships)) to
demonstrate the config-declared relationships feature. `org_id` is denormalized
onto every tenant-scoped table so each RBAC row filter is a one-liner.

The same schema + seed also exists as dialect ports for SQL Server
([`seed.mssql.sql`](./seed.mssql.sql)) and MySQL ([`seed.mysql.sql`](./seed.mysql.sql));
each file's header lists the dialect differences (identity handling, routine
shapes, and — for MSSQL — the `dbo.`-qualified `virtualColumnFunction` call).

---

## 3. Seed the auth users

Users live in Graphoria's auto-created `auth."user"` table — **not** in a
`public.users` table. Each user's `role` drives RBAC; tenant + profile data lives
in `claims`, hoisted into filters as `$session.<key>`. The task/project/comment
rows reference these usernames.

```bash
# Acme (org 1)
bunx graphoria seed-auth --config ./graphoria.ts --user alice --password 's3cret' --role admin   --claims '{"org_id":1,"full_name":"Alice Adams"}'
bunx graphoria seed-auth --config ./graphoria.ts --user molly --password 's3cret' --role manager --claims '{"org_id":1,"full_name":"Molly Ng"}'
bunx graphoria seed-auth --config ./graphoria.ts --user evan  --password 's3cret' --role member  --claims '{"org_id":1,"full_name":"Evan Lee"}'

# Globex (org 2)
bunx graphoria seed-auth --config ./graphoria.ts --user gina  --password 's3cret' --role admin   --claims '{"org_id":2,"full_name":"Gina Park"}'
bunx graphoria seed-auth --config ./graphoria.ts --user max   --password 's3cret' --role member  --claims '{"org_id":2,"full_name":"Max Roy"}'
```

`--role` must match a key under `auth.permissions`: `member`, `manager`, or
`admin`. No token at all → `anonymous`. The admin-secret header → `superadmin`
(bypasses RBAC).

---

## 4. Run it

Create `.env` next to [`index.ts`](./index.ts):

```bash
ADMIN_SECRET=dev-admin-change-me
JWT_SECRET=dev-secret-change-me
CACHE_STORE=redis
REDIS_URL=redis://localhost:6379
LLM_PROVIDER=ollama          # AI agent default; or set OPENAI_API_KEY / ANTHROPIC_API_KEY
```

Then:

```bash
bun add @graphoria/server   # if this folder isn't already inside the workspace
bun run index.ts
```

Get a token to use in the examples below:

```bash
curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation{auth_login(username:\"evan\",password:\"s3cret\"){access_token role}}"}'
# export TOKEN=<access_token>
```

---

## 5. Feature tour

Each feature names the part of [`graphoria.ts`](./graphoria.ts) that enables it,
plus a way to exercise it.

### Auto-generated CRUD (GraphQL + REST)

Listing a database under `databases` generates filter / order / paginate queries
and insert / update / delete mutations for every table, on both `/graphql` and
`/rest/*`.

```graphql
query {
  public_tasks(where: { status: { eq: "todo" } }, order_by: { priority: desc }, limit: 10) {
    id
    title
    priority
  }
}
```

### Description overrides

Tables/columns inherit Postgres comments; config overrides win and surface in the
SDL, Scalar docs, and MCP `describe_entity`. → `schema.database.public_tasks.description` / `columnDescriptions`.

### Relationships

Two sources, both add a nested field that joins on the given columns — this is
what makes the tables traversable in one query. Most are **real FKs in
[`seed.pg.sql`](./seed.pg.sql)** that Graphoria introspects automatically. `task_tags`
has none; its relationships are declared in config → `schema.database.*.relationships`.

```typescript
public_task_tags: {
  relationships: [
    { schema: "public", name: "tags", columns: [{ source: "tag_id", target: "id" }] },
  ],
}
// public_tasks also keeps its config-declared task_tags relationship (M:N via tags).
```

### Virtual columns

Two kinds, both on `public_tasks` → `schema.database.public_tasks.columns`:

```typescript
virtualColumnExpression("is_overdue", "boolean", false,
  "CASE WHEN due_date < NOW() AND status <> 'done' THEN true ELSE false END"),
virtualColumnFunction("age_days", "int", false, "task_age_days", ["created_at"]),
```

`select { id is_overdue age_days }` — task 1 and 4 return `is_overdue: true`.

### Directives

Transform values inline (chain left-to-right) and conditionally include fields:

```graphql
query Tour($withDesc: Boolean = false) {
  public_tasks {
    title @uppercase @truncate(length: 20)
    created_at @dateFormat(format: "YYYY-MM-DD")
    description @when(and: ["$withDesc"])
  }
}
```

### Stored procedures

The `project_stats` SQL function ([`seed.pg.sql`](./seed.pg.sql)) is exposed and gated
by the `storedProcedures` permission key (manager + admin only).

### Authentication + token strategies

`auth.enabled` turns on `auth_login` / `auth_refresh` / `auth_logout` and the
user table. Default strategy is JWT; swap to PASETO with the `tokenStrategy` field
(or the `AUTH_STRATEGY` env var) — same database, no schema change.

### RBAC: roles, rows, columns, ordering, session variables

Each role gets its own compiled schema → `auth.permissions`. The headline demo is
tenant isolation via the hoisted `$session.org_id` claim. `anonymous` is limited
to `visibility = "public"` projects with a column allow-list; `member` filters
every tenant table by `org_id` and gets a per-role default `orderBy`.

Verify: `evan` (org 1) and `max` (org 2) running the same `public_tasks` query
see disjoint rows. `superadmin` (admin-secret header) sees everything.

### Operations (query + handler, hooks, cache, repository, OpenAPI)

`Dashboard` is a **query operation** — cached, REST + GraphQL, with a
`beforeRequest` hook. `createTaskWithComment` is a **handler operation** — it uses
the typed raw-SQL `repository`, runs an `init` hook once at boot, and fans out a
queue event. Both Zod `input`/`output` schemas feed `/openapi.json`. → `operations`.

```bash
curl "localhost:3000/rest/dashboard?assignee=evan" -H "Authorization: Bearer $TOKEN"
```

```graphql
mutation {
  createTaskWithComment(
    input: {
      org_id: 1
      project_id: 1
      title: "Add footer"
      assignee: "evan"
      created_by: "molly"
      comment: "low priority"
    }
  ) {
    taskId
    commented
  }
}
```

### Queues + Subscriptions (RabbitMQ)

The `taskAssigned` publisher becomes a GraphQL mutation `events_taskAssigned`
(also called from the handler above). The `taskFeed` subscriber becomes a GraphQL
subscription `events_taskFeed` _and_ invalidates the `Dashboard` cache on every
message. → `queues`.

```graphql
subscription {
  events_taskFeed {
    id
    message
  }
}
```

Trigger it by running `createTaskWithComment` in another tab. Inspect the broker
at http://localhost:15672 (guest/guest).

### Cron

One job → `cron`: `overdueSweep` (daily 09:00, query + `onTick` with `protect`
over-run guard).

### AI agent + MCP

`ai.enabled` adds admin-only NL→DB Q&A (`POST /ai` + GraphQL `ask`).
`ai.mcp.enabled` adds the `POST /mcp` Model Context Protocol endpoint. → `ai`.

```bash
curl -X POST localhost:3000/ai -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" -d '{"prompt":"how many overdue tasks does Acme have?"}'
```

### Playgrounds

`GET /graphiql` (GraphiQL) and `GET /scalar` (Scalar API docs) are always on. The
`@graphoria/react` SDK consumes the same API from a frontend.

---

## Feature → where to look

| Feature                          | Location                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| Auto CRUD, filter/order/paginate | `graphoria.ts` → `databases[0]`                                  |
| Description overrides            | `databases[0].schema.database.public_tasks`                      |
| Relationships (FK + config)      | `seed.pg.sql` FKs · `schema.database.*.relationships`            |
| Virtual columns (expr + func)    | `public_tasks.columns` + `task_age_days` in `seed.pg.sql`        |
| Custom repository                | `databases[0].repository`                                        |
| Directives                       | query-time (`@uppercase`, `@dateFormat`, `@when`, …)             |
| Stored procedures                | `project_stats` in `seed.pg.sql` + `storedProcedures` permission |
| Auth + token strategies          | `tokenStrategy`, `auth`                                          |
| RBAC rows/cols/orderBy/session   | `auth.permissions`                                               |
| Admin-secret bypass              | `x-admin-secret` header → `superadmin`                           |
| Operations (query + handler)     | `operations.Dashboard`, `operations.createTaskWithComment`       |
| Hooks / cache / OpenAPI          | `operations.*.hooks` / `.cache` / `.input` + `.output`           |
| Queues + publishers              | `queues[0].publishers.taskAssigned`                              |
| Subscriptions                    | `queues[0].subscribers.taskFeed`                                 |
| Cron                             | `cron`                                                           |
| AI agent + MCP                   | `ai`                                                             |
| Playgrounds                      | `/graphiql`, `/scalar` (always on)                               |

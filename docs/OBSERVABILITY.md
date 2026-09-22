# Observability

What a running Graphoria server tells you about itself: health endpoints for an orchestrator's
probes, and a log line for every statement that runs too long. The [audit log](../README.md#audit-log)
records privileged actions, and the [admin console](./CONSOLE.md) has a status page for a human.

## Health endpoints

| Verb | Path            | Answers                                                            |
| ---- | --------------- | ------------------------------------------------------------------ |
| GET  | `/health/live`  | `200` whenever the process serves HTTP. Touches nothing else.      |
| GET  | `/health/ready` | `200` when every dependency answers, `503` while any one does not. |

Both are always mounted, under `PREFIX` when one is set (`PREFIX=/api` gives `/api/health/ready`).
They need **no credential and are not rate limited**, because a probe that got a `401` or a `429` would
take a healthy pod out of rotation. That makes them different from the console's `/api/status`, which
needs a console session and reports far more.

**Liveness** checks no dependency on purpose. An orchestrator restarts a process that fails it, and
restarting a server because its database is down does not bring the database back.

**Readiness** checks, side by side and each bounded at 2 seconds:

| `kind`              | `name`                  | Checked when                           | How                                                             |
| ------------------- | ----------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `database`          | the database's `name`   | always, one check per enabled database | `SELECT 1` on its pool                                          |
| `redis`             | —                       | `auth.enabled`, or `CACHE_STORE=redis` | `PING`                                                          |
| `rabbitmq`, `kafka` | the queue config's name | always, one check per configured queue | The connection state its reconnecting manager keeps. No traffic |

```json
{
  "status": "unavailable",
  "checks": [
    { "kind": "database", "name": "main", "ok": false },
    { "kind": "redis", "ok": true },
    { "kind": "rabbitmq", "name": "events", "ok": true }
  ]
}
```

`status` is `ok` on a `200` and `unavailable` on a `503`. **The body says which check failed, never
why.** A driver error can carry a host and a port, and this endpoint answers anyone who can reach it.
The reason goes to one `warn` line per failed check, tagged `component: "health"`.

Remote GraphQL schemas and remote REST upstreams are not checked. They belong to someone else, and
one of them being down should not pull every replica out of rotation.

### Recovery

Readiness turns back to `200` on the first probe after the dependency answers again:

- **Databases** open a fresh connection on the next statement. No restart is needed.
- **Redis** clients reconnect on their own. That includes outages long enough to exhaust the Redis
  client's own retries, after which Graphoria keeps reconnecting with a backoff from 1 to 30 seconds.
- **Brokers** retry with the same backoff, capped at 30 seconds, so readiness can report a broker
  down for up to 30 seconds after it is back.

### Kubernetes

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
```

Set `timeoutSeconds` above the 2-second bound on each check. Kubernetes' default of `1` would time
out a probe that Graphoria was about to answer.

Every readiness request runs one `SELECT 1` per database and one `PING`, and takes a pooled
connection to do it, like any query. It is cheap, but it can be triggered without a credential. If
the server is reachable from the internet, keep `/health/*` off the public route.

## Slow query log

A statement that runs longer than `SLOW_QUERY_MS` (default `1000`, `0` turns it off) is written as one `warn` record tagged `component: "slow-query"`, with the SQL that ran and the GraphQL operation it was generated for. That covers caller queries, stored-procedure mutations and subscription polls, and through them REST operations, cron jobs and MCP, which all execute through the GraphQL handler. Two kinds of statement bypass it and are never reported: the ones an operation handler runs itself through `databases` or `repository`, and the auth tables' own lookups.

```json
{
  "component": "slow-query",
  "msg": "slow query",
  "durationMs": 1843.2,
  "thresholdMs": 1000,
  "dbType": "pg",
  "dbName": "main",
  "sql": "SELECT … FROM \"public\".\"orders\" …",
  "operation": { "type": "query", "name": "RecentOrders", "fields": ["orders"] },
  "role": "user",
  "outcome": "success"
}
```

A stored procedure carries `procedure` in place of `sql`. A statement that fails after crossing the threshold — one cancelled by `QUERY_TIMEOUT_MS`, say — is recorded too, with `outcome: "error"`. `operation.name` is `null` for an anonymous operation; `fields` still names the root fields it asked for.

Variable values are never recorded, and neither is the GraphQL document: every literal in a document reaches the database as a bound parameter, so the SQL text carries no caller data, but the document itself would. Unlike audit records, slow-query records follow `LOG_LEVEL`, so `LOG_LEVEL=error` silences them.

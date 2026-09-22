# Observability

What a running Graphoria server tells you about itself: health endpoints for an orchestrator's
probes, a log line for every statement that runs too long, a Prometheus exposition of its request,
cron and queue counters, and an OTLP trace per request. The [audit log](../README.md#audit-log)
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

## Metrics

A Prometheus exposition of what the server is doing, at `/metrics`. It ships **off**: set
`METRICS_ENABLED=true` to mount the route, and it is not mounted at all while off — a scrape gets
`404`, not `401`.

A scrape has to carry a credential in the admin-secret header (`x-admin-secret` by default), because
the series name your operations, your roles and your databases. `METRICS_SECRET` is the scoped
credential for it and opens nothing else; `ADMIN_SECRET` works too, as the superset, and writes a
`warn` line each time it is used where the scoped one would have done — once per scrape, so hand
Prometheus `METRICS_SECRET`.

```yaml
scrape_configs:
  - job_name: graphoria
    static_configs:
      - targets: ["graphoria:3000"]
    authorization: # Prometheus sends this as `Authorization`, so use a header instead:
    http_headers:
      x-admin-secret:
        values: ["<METRICS_SECRET>"]
```

Unlike every other credentialled route, `/metrics` is not rate limited: a scrape interval is fixed,
and counting it against a caller ceiling would drop samples.

### What is exported

| Metric                                         | Type      | Labels                                   | Means                                                                            |
| ---------------------------------------------- | --------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `graphoria_http_requests_total`                | counter   | `route`, `method`, `status`              | Requests answered by the GraphQL and REST routes. `route` is `graphql` or `rest` |
| `graphoria_http_request_duration_seconds`      | histogram | `route`, `method`                        | Time to answer one of those requests                                             |
| `graphoria_graphql_operations_total`           | counter   | `operation`, `type`, `role`, `outcome`   | Operations handled. `outcome` is `success` or `error`                            |
| `graphoria_graphql_operation_duration_seconds` | histogram | `operation`, `type`, `role`              | Time spent handling one, database time included                                  |
| `graphoria_graphql_rejections_total`           | counter   | `reason`                                 | Operations refused before execution: `depth`, `cost` or `validation`             |
| `graphoria_rate_limit_rejections_total`        | counter   | `role`                                   | Requests the rate limiter refused, by the role its ceiling came from             |
| `graphoria_cron_runs_total`                    | counter   | `job`, `outcome`                         | Cron ticks that finished or threw                                                |
| `graphoria_cron_run_duration_seconds`          | histogram | `job`                                    | Time spent in a tick                                                             |
| `graphoria_queue_messages_published_total`     | counter   | `broker`, `publisher`, `outcome`         | Messages handed to a broker. `outcome: "error"` covers a refused publish         |
| `graphoria_queue_messages_consumed_total`      | counter   | `broker`, `queue`, `consumer`, `outcome` | Messages delivered. `error` means the handler threw and the message was nacked   |

Histogram buckets are in seconds: `.005 .01 .025 .05 .1 .25 .5 1 2.5 5 10`, plus `+Inf`, `_sum` and
`_count`.

`role` is `anonymous` for an unauthenticated caller. `operation` is the operation's name, or its root
field names joined by a comma when the document is anonymous — never the document itself, which
would carry inline literals, and never variable values. It is the same rule the slow query log
follows.

### Cardinality

`operation` is the one label a caller controls, and it is capped. The first
`METRICS_MAX_OPERATION_LABELS` (default `200`) distinct names each get their own series, and every
name after that is recorded as `operation="other"` — a client sending a fresh operation name per
request cannot grow the exposition without bound. The cap is per metric and counts for the lifetime
of the process. Names already known keep their own series after the cap is reached.

Raise it if you have more than 200 distinct named operations and want each one separately; watch the
exposition's size when you do.

### Cost

Recording is a counter increment and a bucket increment behind one boolean. Measured at roughly 70ns
for a counter and 134ns against a histogram, against 1–50ms for a database round trip — so it does
not show up in a request. While `METRICS_ENABLED` is off every call site pays one branch (~30ns) and
allocates nothing. `metrics.perf.test.ts` holds those bounds an order of magnitude loose, so the
suite catches a change that makes recording expensive without turning red on a busy CI runner.

### Not exported

Deliberately, for now: per-statement database timings and pool utilization (the slow query log
covers the first, and two of the three engines expose no pool statistics), cache hit ratio, and
queue depth and consumer lag — the last needs RabbitMQ's management API and a Kafka admin client,
which is new I/O on a timer rather than a counter in the request path.

Not covered by the series above, which is a gap rather than a decision: **subscriptions**. A
subscription is validated through the same path, so a rejected one is counted in
`graphoria_graphql_rejections_total`, but the rows a poller pushes do not go through the GraphQL
handler and are not counted or timed. The websocket upgrade itself answers no request, so it is not
in `graphoria_http_requests_total` either. What a subscription publishes through a broker is
counted, since that goes through a publisher.

## Tracing

One trace per request, from the HTTP handler down to the statements the database ran, exported over
OTLP/HTTP to any OpenTelemetry collector. It ships **off**: set `TRACING_ENABLED=true` to turn it
on. While off, a span site costs about 80ns — the attributes its caller builds, then one boolean —
and the async context is never entered.

Everything but the gate reads the standard OpenTelemetry variable names, so a cluster whose operator
already injects them into its pods sets one graphoria-specific variable and inherits the rest.

| Variable                      | Default                 | Means                                                                   |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `TRACING_ENABLED`             | `false`                 | The gate                                                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base URL; spans are posted to `${endpoint}/v1/traces` as OTLP/HTTP JSON |
| `OTEL_EXPORTER_OTLP_HEADERS`  | _(empty)_               | `k=v,k2=v2`, sent on every export — an API key for a hosted collector   |
| `OTEL_SERVICE_NAME`           | `graphoria`             | The OTLP resource's `service.name`                                      |
| `OTEL_TRACES_SAMPLER_ARG`     | `1`                     | Head-sampling ratio, `0`–`1`. See [Sampling](#sampling)                 |

The resource also carries `service.version`, taken from the running package's version, so a trace
names the build it came from.

There is no new runtime dependency: the ids, the W3C propagation and the OTLP payload are written by
hand, the same way the Prometheus exposition above is.

### What is traced

| Span                      | Kind     | Opened by                            | Attributes                                                                                       |
| ------------------------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `<METHOD> <route>`        | server   | The GraphQL and REST routes          | `http.request.method`, `http.route`, `url.scheme`, `server.address`, `http.response.status_code` |
| `graphoria.analyze`       | internal | The GraphQL handler                  | `graphoria.analysis.cached`                                                                      |
| `<type> <operation>`      | internal | The GraphQL handler                  | `graphql.operation.name`, `graphql.operation.type`, `graphoria.role`                             |
| `db.query`                | client   | Every statement through the executor | `db.system`, `db.name`, `db.statement`, plus the operation's name, type and role when it has one |
| `db.procedure`            | client   | A stored-procedure call              | `db.system`, `db.name`, `db.operation` — the dotted procedure name, and no statement             |
| `subscription.poll`       | internal | Each poll of a database subscription | `graphql.operation.name`, `graphql.operation.type`, `graphoria.role`                             |
| `cron.tick`               | internal | Each cron tick                       | `graphoria.cron.job`                                                                             |
| `queue.publish`           | producer | Each publish to a broker             | `messaging.system`, `messaging.destination.name`, `graphoria.queue.publisher`                    |
| `graphoria.remote_schema` | client   | A remote GraphQL field               | `http.request.method`, `server.address`, `http.response.status_code`                             |
| `graphoria.remote_rest`   | client   | A remote REST proxy                  | `http.request.method`, `server.address`, `http.response.status_code`                             |

A request roots one trace; a cron tick and a subscription poll each root their own, because neither
sits inside one. REST operations, cron queries, an operation hook's `gqlQuery` and MCP's
`graphql_execute` all run through the GraphQL handler, so they get the operation span without
anything further.

An operation is named the way the metrics label and the slow query log name one: its own name, or
its root field names joined by a comma when the document is anonymous.

**Variable values are never recorded, on any span, ever. Neither is the GraphQL document, a queue
message's body, or a remote URL's path and query string** — a remote span carries the host alone.
`db.statement` holds the generated SQL in full because every literal in a document is hoisted into a
bound parameter before it reaches the database, so the statement text carries no caller data. The
document would carry those literals verbatim, which is why it never appears.

### Propagation

An inbound `traceparent` is honored: a well-formed one continues that trace and the server's span
becomes a child of the caller's. A malformed one is ignored and a fresh trace starts — it never
throws into the request path. `tracestate` is passed along unmodified but is neither parsed nor
extended.

Outbound, a remote schema call and a remote REST proxy each carry a `traceparent` for the client
span they opened, so a remote service's spans join the same trace.

A caller can forge a trace id and cost your trace store an entry. That is the exposure every
OTel-instrumented service accepts, and the sampler below bounds the volume.

### Sampling

The sampler is head-based and decides once, at the root of a trace; a child never re-samples, so a
trace is never half-recorded. `OTEL_TRACES_SAMPLER_ARG` is the ratio, defaulting to `1` — whoever
turned tracing on wants the traces. Lower it on a busy deployment without touching collector config.

When an inbound `traceparent` is present its sampled flag decides and the local ratio is not
consulted, so an upstream service's decision holds for the whole trace.

### Cost

A span costs roughly 3µs to start and end, and about the same again when it enters the async
context, against 1–50ms for a database round trip.

While `TRACING_ENABLED` is off a span site costs about 80ns, and that cost is the caller's, not the
tracer's: the attributes are an argument expression, so they are built and allocated before
`startSpan` is entered and can consult the gate. The gate check itself is a boolean. Measuring
`startSpan(name)` with no attributes reports a few nanoseconds, which is the optimizer dropping an
allocation nothing consumes rather than what a span site costs — `tracing.perf.test.ts` bounds the
call-site shape for that reason. Its bounds sit several times above the measurements, so the suite
catches a change that makes tracing expensive without turning red on a busy CI runner.

Spans are batched and posted in the background: at most 512 per export, every 5 seconds, and at most
2048 queued. Past that ceiling the **oldest** spans are dropped and a `warn` line says how many — the
thing that observes the server must never be the thing that sinks it. A failed export is logged at
`warn` and the batch is dropped. There is no retry buffer, deliberately: an unbounded one is the
failure mode that turns an observability feature into the outage.

The export timer does not hold the process open. There is no graceful-shutdown hook, so whatever
was queued when the process exits is lost; call `flushSpans()` from your own shutdown path if you
have one.

### Not traced

Deliberately: **cache lookups**. A hit on the in-process LRU is sub-microsecond, so a span per lookup
is export volume for a number that is always about zero. Worth revisiting if the Redis cache store
becomes the common path, where a lookup is real I/O.

Not covered, which is a gap rather than a decision: statements that **bypass the executor** —
whatever an operation handler runs itself against a raw pool from `databases` or `repository`, and
the auth tables' own lookups. It is the same boundary the slow query log documents; closing it means
wrapping the pools handed to operator code.

The rows a subscription pushes are covered, unlike in the metrics above: a poll is a unit of work
with a start, an end and statements under it, so it roots a trace the way a cron tick does. The
websocket upgrade itself answers no request, so it gets no span.

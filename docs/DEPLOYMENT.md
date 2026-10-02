# Deployment

> **See also:** [Quickstart](./QUICKSTART.md) | [Configuration Reference](./CONFIGURATION.md) | [Observability](./OBSERVABILITY.md) | [Resource Limits](./LIMITS.md) | [Security Model](./SECURITY_MODEL.md)

From the container image to a production deployment: what runs where, the proxy and TLS in front,
how many processes and database connections to plan for, what Redis holds, how the server stops,
how to roll out a new version without failing requests, what to back up, and a Kubernetes manifest
that puts it together.

The measured numbers below come from the
[Docker Compose starter](../examples/docker-compose-starter/) (one Postgres database, two tables)
on Bun 1.4.2. They are there to size from; measure your own project before relying on them.

## What you deploy

Graphoria runs as your project's image: your `graphoria.ts`, the `index.ts` that starts the server,
and `@graphoria/server` from npm, with `@graphoria/queues` next to it when the configuration has
queues. The process writes nothing to local disk, so any replica can answer any request and a
replaced container loses nothing. The state lives elsewhere:

| Component             | Holds                                                                                      | Needed when                        |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| Your project image    | Configuration and code                                                                     | Always                             |
| Database(s)           | Your data; with auth on, the users table (schema `auth` by default)                        | Always                             |
| Redis                 | Refresh-token rotation and revoked tokens; with `CACHE_STORE=redis`, cache and rate limits | Auth on, or `CACHE_STORE=redis`    |
| RabbitMQ / Kafka      | Queue messages                                                                             | A `queues` entry in `graphoria.ts` |
| Reverse proxy/gateway | The TLS certificate                                                                        | Always: the server speaks HTTP     |

## The image

Build it from the recipe in [`examples/docker-compose-starter/`](../examples/docker-compose-starter/);
its README lists
[what the recipe relies on](../examples/docker-compose-starter/README.md#using-the-recipe-in-your-own-project).
`graphoria init` writes the same `Dockerfile` into a new project. The recipe gives you:

- `oven/bun:<version>-slim` in both stages: Debian slim with Bun, no compiler and no curl.
- `bun install --frozen-lockfile --production` from the committed `bun.lock`.
- The non-root `bun` user, uid and gid `1000`, which cannot write under `/app`.
- `NODE_ENV=production`, lowercase. That exact value, and not `PRODUCTION`, switches the logs to
  one JSON object per line and the default `LOG_LEVEL` to `info`.
- A `HEALTHCHECK` on `/health/live`, made with `bun -e` since the image has no curl.

Pin both versions: the Bun tag in the two `FROM` lines, and `@graphoria/server` exactly
(`bun add --exact`), since Graphoria is pre-1.0 and a minor release can change behaviour.

The image runs with a read-only root filesystem: the starter boots, serves and passes its
healthcheck with nothing writable. `PRINT_SCHEMAS` writes the generated schemas under the project
directory: keep it off in the image, or point `SCHEMAS_OUTPUT_DIR` at a writable volume.

## Configuration and secrets

Environment variables configure the server. They are read once at startup, so a change takes a
restart, a rolling one on a fleet. The ones a deployment sets:

| Variable                            | Default                  | Means                                                                                                          |
| ----------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ADMIN_SECRET`                      | — (required)             | Bypasses RBAC. The server does not start without it                                                            |
| `JWT_SECRET`                        | —                        | Signs tokens under the default `jwt` strategy. Required with auth or the console on; PASETO takes its own keys |
| `NODE_ENV`                          | `DEVELOPMENT`            | `production`, lowercase, for JSON logs at `info`                                                               |
| `PORT`                              | `3000`                   | Listen port, on every interface                                                                                |
| `PREFIX`                            | —                        | Path prefix for every route, the health endpoints included                                                     |
| `REDIS_URL`                         | `redis://localhost:6379` | See [Redis](#redis)                                                                                            |
| `CACHE_STORE`                       | `memory`                 | `redis` shares the REST cache and the rate limits across processes                                             |
| `RATE_LIMIT_TRUST_PROXY`            | `false`                  | Take the client address from `X-Forwarded-For` — see [The client address](#the-client-address)                 |
| `SHUTDOWN_TIMEOUT_MS`               | `8000`                   | Drain time on SIGTERM — see [Graceful shutdown](#graceful-shutdown)                                            |
| `DB_CONNECT_RETRY_MS`               | `60000`                  | How long boot waits for a database it cannot reach                                                             |
| `METRICS_ENABLED`, `METRICS_SECRET` | `false`, —               | Prometheus `/metrics` — see [Metrics](./OBSERVABILITY.md#metrics)                                              |
| `CONSOLE_ENABLED`                   | `false`                  | The [admin console](./CONSOLE.md) at `/_console`                                                               |

Everything else is in [`.env.example`](../.env.example).
[Configuring for production](./LIMITS.md#configuring-for-production) covers the limits worth turning
on, and the [Production checklist](../README.md#production-checklist) the rest.

- The server listens on `PORT` on every interface. Do not pass `port` to `createBunServer` in
  `index.ts`: a port in code overrides `PORT`, and the image's healthcheck probes `PORT`.
- Secrets come from the orchestrator — the environment of a Compose service, a Kubernetes Secret —
  never from the image. The recipe's `.dockerignore` keeps every `.env*` file out of it, because
  Bun loads `.env` from its working directory.
- `ADMIN_SECRET`, `JWT_SECRET` and the other secret variables accept a comma-separated list, so
  rotating one is two rolling restarts with no cut-over. See
  [Rotating secrets](./AUTHENTICATION.md#rotating-secrets).

## Reverse proxy and TLS

The server has no TLS. A proxy in front terminates it. HTTPS is not optional once auth or the
console is on: the refresh-token and console-session cookies are `Secure`, and a browser does not
send them over plain HTTP.

For a VM or a Compose stack, this Caddyfile is the whole proxy. Caddy manages the certificate for
the site address itself ([automatic HTTPS](https://caddyserver.com/docs/automatic-https)).
[`examples/deploy-caddy/`](../examples/deploy-caddy/) runs it in front of the starter project.

```caddyfile
api.example.com {
	# Only the public API: the rest of what Graphoria serves stays on the private network.
	@api path /graphql /rest /rest/*
	handle @api {
		request_body {
			max_size 1MB
		}
		reverse_proxy graphoria:3000 {
			transport http {
				# Below the server's 10 s idle timeout, so Caddy never reuses a connection the
				# server is closing.
				keepalive 5s
			}
		}
	}
	handle {
		respond 404
	}
}
```

Run Caddy next to the app (`caddy:2` in the same Compose file), publish its ports `80` and `443`,
and stop publishing the app's. What the Caddyfile does, each point measured with Caddy 2.11 in
front of the starter:

- **Only the API is public.** `/graphql` (queries, mutations and the websocket) and `/rest` reach
  Graphoria; every other path gets a `404` from Caddy. That keeps these off the internet:
  - `/health/*` needs no credential, and each readiness request runs a query on every database;
  - `/metrics` is secret-gated but not rate limited;
  - `/_console` is the operator console, opened by the admin secret or a console secret;
  - `/mcp` is for AI tooling and needs
    [no credential by default](./SECURITY_MODEL.md#the-mcp-endpoint-is-unauthenticated-by-default);
  - `/openapi.json` is public and
    [describes the superadmin surface](./SECURITY_MODEL.md#openapijson-is-public-and-describes-the-superadmin-surface);
  - `/graphiql` and `/scalar` are the playgrounds. Their introspection is per role, so add them to
    the matcher if you want them public.

  With `PREFIX` set, prefix the matched paths. The [AI agent](./AI.md), when it is on, is not kept
  off: it answers at `/rest/ai` and as the GraphQL `ask` field, on the public route like the rest of
  the API, and only to the admin secret or `AI_SECRET`.

- **A body limit.** Graphoria sets none of its own, so Bun's default of 128 MiB applies. With
  `max_size 1MB` Caddy answers `413` above one megabyte; size it to your largest mutation.
- **Keep-alive below 10 seconds.** The server closes a keep-alive connection after 10 seconds idle.
  Caddy keeps an idle upstream connection for 2 minutes by default
  ([`keepalive`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#keepalive)), so it
  could send a request down a connection the server is closing; `keepalive 5s` retires Caddy's
  first.
- **Websockets** pass through with no extra configuration. A subscription socket with no traffic
  stayed open for the 5 minutes measured, through Caddy and directly. Other proxies close idle
  websockets sooner, so clients should ping every 20–30 seconds anyway — see
  [Pings and keepalives](./SUBSCRIPTIONS.md#pings-and-keepalives).

### The client address

Behind a proxy every request comes from the proxy's address, so the rate limiter puts every client
in one bucket and the [audit log](../README.md#audit-log) records the proxy as the actor. Set
`RATE_LIMIT_TRUST_PROXY=true` and Graphoria takes the **leftmost** `X-Forwarded-For` entry instead,
capped at 64 characters. `X-Real-IP` and `X-Forwarded-Proto` are not read.

The leftmost entry is the client only if the proxy wrote it. A client can send its own
`X-Forwarded-For`, and a proxy that appends to it leaves the client's value leftmost: the client
then chooses its own rate-limit bucket and the address the audit log records.

- **Caddy** replaces the header unless the sender is in its
  [`trusted_proxies`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).
  Measured: a client sending `X-Forwarded-For: 203.0.113.9` was recorded under its real address.
- **Envoy Gateway**, with its defaults, appends. Measured: the same client was recorded as
  `203.0.113.9`. The [Kubernetes example](#with-envoy-gateway) removes the header first.
- **Any other proxy**: send a request with a made-up `X-Forwarded-For` and the admin secret, then
  read `actor.ip` on the `admin_secret.used` audit record.

The entry the proxy writes is the peer it sees. If a load balancer in front of the proxy rewrites
source addresses, that peer is the load balancer, and every client shares its address again;
preserving the client address there is the load balancer's setting.

Leave `RATE_LIMIT_TRUST_PROXY` off when nothing sits in front: the header then comes straight from
the client.

### CORS

Every response Graphoria builds allows any origin: `Access-Control-Allow-Origin: *` with
`Access-Control-Allow-Credentials: true`, on GraphQL and REST alike. No variable narrows the
origin. `CORS_ENABLED` (default `true`) only decides whether the server answers `OPTIONS`
preflights; the headers are sent either way. What that means in a browser, measured with Chrome:

- A page on any origin can call the API with a bearer token or a credential header, which the page
  holds itself.
- No page on another origin can use a cookie: a browser refuses a response to a request sent with
  `credentials: "include"` when the answer is `*`. The refresh-token cookie and the console session
  work only when the frontend is served from the API's own origin — the same host at the proxy.
- With `CORS_ENABLED=false`, `OPTIONS` gets a `404`, so a page on another origin cannot send a
  JSON request at all. Use it when the frontend and the API share an origin.

To allow some origins and not others, replace the CORS headers at the proxy.

## Processes and sizing

One Bun process per container, and replicas to scale: that is the recipe's model and what the
[Kubernetes example](#kubernetes-example) runs. On a VM without an orchestrator, the `graphoria`
CLI runs several processes on one port, from a configuration file rather than an `index.ts`:
`graphoria --config ./graphoria.ts --workers 4` (or `--cluster`, one per core). They share the port
through `SO_REUSEPORT`, which spreads connections across them on Linux only. The CLI restarts a
process that crashes, after 1 second and doubling up to 30, and exits non-zero at the 5th crash
within 60 seconds. A database that is down at boot does not reach that limit with the default
window: see [Waiting for the database at boot](./CONFIGURATION.md#waiting-for-the-database-at-boot).

Whichever way you get more than one process, some state stays per process:

- **Rate limits.** The memory store counts per process; `CACHE_STORE=redis` makes one bucket. See
  [the in-memory rate limiter](./SECURITY_MODEL.md#the-in-memory-rate-limiter-does-not-span-workers).
- **Console logout** revokes the session in the process that served it only; the cookie stays
  valid elsewhere until it expires. See
  [Console logout binds one worker](./SECURITY_MODEL.md#console-logout-binds-one-worker).
- **Cron** runs every job in every process, with no lock between them. See
  [Patterns and pitfalls](./CRON.md#patterns-and-pitfalls).
- **Queue subscribers.** Without a `queue` (RabbitMQ) or a `group` (Kafka), each process gets its
  own randomly named queue or consumer group, so every process receives every message. Name one to
  make the processes share the work: each message then reaches one process, and only the GraphQL
  subscriptions on that process. Leave a named RabbitMQ queue non-`exclusive`: an exclusive queue
  serves one connection only, a second process is refused it and stays unready (which holds up a
  rollout that waits on readiness), and RabbitMQ 4 makes it transient. See
  [Subscribers](./QUEUES.md#subscribers).

**Resources.** The starter idles at about 125 MiB and 0.2 % of a core. Answering 10,000 REST
requests at 20 concurrent (1.9 s) it peaked at about 175 MiB and 1.6 cores, and went back to
125 MiB. The Kubernetes example requests 100m CPU and 256 MiB, with a 512 MiB memory limit; a
bigger schema, more roles and larger responses all raise these.

## Database connections

Each process keeps its own pool per database, of up to `max` connections (`pool.max` on SQL
Server), 10 by default. Boot opens one more, briefly, to read each database's structure. A rolling
deploy runs the new and old replicas side by side, so for each database server:

```text
(replicas + maxSurge) × processes per replica × (max + 1)  ≤  max_connections − reserved − headroom
```

With several databases on one server, add their pools. For 2 replicas, `maxSurge: 1`, one process
each and one database at the default `max`: 3 × 1 × 11 = 33 connections at most. The engine
defaults to hold that against, as shipped (check your server's, managed services set their own):

| Engine     | `max_connections` default                  |
| ---------- | ------------------------------------------ |
| PostgreSQL | 100, 3 of them reserved for superusers     |
| MySQL      | 151                                        |
| SQL Server | 32,767 (`user connections` 0, the maximum) |

Keep headroom for migrations, admin sessions and anything else that connects. Every readiness
probe takes a pooled connection per database, and every distinct live subscription polls its query
on the pool once a second. When the product is too large, lower `max` in `connectionOptions` — see
[Connection pool bounds](./LIMITS.md#connection-pool-bounds).

Graphoria connects as one database user and can do whatever that user can. Grant it only what the
API needs ([Out of scope](./SECURITY_MODEL.md#out-of-scope)).

## Redis

What Redis holds, and what happens when it goes away:

| When                | Holds                                   | While Redis is down                                                            | After Redis loses its data                                                         |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Auth on             | Refresh-token rotation, revoked tokens  | **Fails closed**: a valid bearer token is served as `anonymous`; refresh fails | Revoked tokens verify again; a used refresh token can be replayed until it expires |
| `CACHE_STORE=redis` | The REST cache, the rate-limit counters | **Fails open**: answers uncached and unlimited                                 | Cache and counters start empty                                                     |

Console sessions and subscriptions are not in Redis.

- **Readiness.** With auth on or `CACHE_STORE=redis`, `/health/ready` includes a Redis `PING`, so a
  Redis outage takes every replica out of rotation at once. Give Redis the availability you give
  the database.
- **Failover.** Graphoria takes one `REDIS_URL` and speaks neither Sentinel nor Cluster. For
  failover, point it at an endpoint that follows the primary under one hostname. The clients
  reconnect on their own, with a backoff from 1 to 30 seconds
  ([Recovery](./OBSERVABILITY.md#recovery)).
- **Persistence.** Turn on AOF so a Redis restart keeps the revocations. If the data is lost
  anyway, replace `JWT_SECRET` (or the PASETO keys) without keeping the old value in the list: every
  token issued before becomes invalid, and every user signs in again.
- **One per deployment.** Two deployments sharing one Redis
  [can serve each other's cached rows](./SECURITY_MODEL.md#two-deployments-sharing-one-redis-can-serve-each-others-rows).
  Give each its own Redis, or its own database number in the URL.

The URL forms, checked with Bun's Redis client:

| Form                              | Means                                                            |
| --------------------------------- | ---------------------------------------------------------------- |
| `redis://:password@host:6379`     | `requirepass` authentication                                     |
| `redis://user:password@host:6379` | ACL user authentication                                          |
| `redis://host:6379/2`             | Database `2`                                                     |
| `rediss://host:6379`              | TLS. For a private CA, set `NODE_EXTRA_CA_CERTS` to its PEM file |

## Graceful shutdown

On SIGTERM or SIGINT, `createBunServer` — and each process of the `graphoria` CLI — stops in three
steps:

1. The listener closes, so new connections are refused. Every open websocket gets a `1001` close
   ("server shutting down"), and cron starts no new run.
2. Requests in flight get up to `SHUTDOWN_TIMEOUT_MS` (default `8000`) to finish. The ones still
   running after that are reset.
3. The queue connections, the Redis clients and the database pools close, and the queued spans are
   flushed, within one second.

The process exits `0` when the drain finished in time and every step succeeded, `1` otherwise. A
second signal exits `1` at once. [Graceful shutdown](./API_REFERENCE.md#graceful-shutdown) has the
detail.

- **No init needed.** The server handles the signal as the container's PID 1: `docker stop` without
  an init returns in well under a second. The recipe's `init: true` in Compose is harmless.
- **During boot** — while it waits for a database, say — a SIGTERM exits `0` at once.
- **Websocket clients** get the `1001` and should reconnect; through the proxy they land on a
  replica still serving.
- **The budget.** The orchestrator's grace period must cover the whole stop: any `preStop` delay,
  plus `SHUTDOWN_TIMEOUT_MS`, plus one second of teardown. Docker waits 10 seconds by default
  (8 + 1 fits); Kubernetes 30 (5 + 8 + 1 fits). Past the grace period the process is killed
  mid-drain, so raising `SHUTDOWN_TIMEOUT_MS` means raising the grace period too.
- **Kubernetes needs a `preStop` delay.** The listener closes the moment SIGTERM arrives, and
  `/health/ready` keeps answering `200` until then; it is removing the pod's endpoint that takes it
  out of rotation, and that reaches the gateway a little after SIGTERM does. A `preStop` sleep
  keeps the pod serving while the removal propagates; SIGTERM arrives when the sleep ends. Measured
  under [Zero-downtime deploys](#zero-downtime-deploys).

## Zero-downtime deploys

- **Rolling update with a surge.** `maxUnavailable: 0` and `maxSurge: 1`: a new replica has to be
  ready before an old one stops. Readiness is `/health/ready`, so a replica that cannot reach its
  database never gets traffic.
- **Boot can wait.** A database that cannot be reached at boot is retried for up to
  `DB_CONNECT_RETRY_MS`, and `/health/live` does not answer until boot is done. With the defaults
  that is up to 90 seconds: the 60-second window plus one 30-second `connectionTimeout`. Size a
  `startupProbe` to cover it, or the liveness probe restarts the pod mid-wait. See
  [Waiting for the database at boot](./CONFIGURATION.md#waiting-for-the-database-at-boot).
- **Measured.** On the [Kubernetes example](#kubernetes-example), `kubectl rollout restart` under a
  loop of GraphQL requests through the gateway: 4 rollouts, 37,375 requests, none failed. Without
  the `preStop` sleep, the same test failed 7 or 8 requests per rollout (3 rollouts): `503`s from
  the gateway, and one request that hung until the loop's 5-second limit.
- **Schema changes are expand, then contract.** Graphoria reads the database structure at boot
  only: a new column or table is served once the replicas restart, and during a rollout old and new
  replicas serve side by side. Add first, and roll out. Drop a column or table only after no
  replica queries it, and after `graphoria.ts` stops naming it: a role that names a missing table
  or column stops the server at boot.
- **Configuration changes** to `graphoria.ts` ship as a new image, and so as a rollout.
- **Secret changes** are rolling restarts with no cut-over — see
  [Rotating secrets](./AUTHENTICATION.md#rotating-secrets).

## Backup and restore

- **Containers** hold nothing: rebuild the image from git and the pinned versions, and redeploy.
- **The database** is the system of record, the users table included (schema `auth` by default).
  Back it up with the engine's own tools; restoring it restores the accounts.
- **Redis** holds token state. After restoring an older copy, or starting empty, tokens revoked
  since then verify again — replace `JWT_SECRET` as in [Redis](#redis). The cache and the
  rate-limit counters need no backup.
- **Console sessions** are tokens signed with the token key: nothing to back up, and changing the
  key signs everyone out.

## Kubernetes example

The core set: a Secret, a Deployment, a Service, a PodDisruptionBudget, and a
[Gateway API](https://gateway-api.sigs.k8s.io/) `Gateway` and `HTTPRoute` for the edge. The
database and Redis are outside the cluster (managed services); their hosts go in the Secret, under
whatever names your `graphoria.ts` reads. The manifest was run on kind (Kubernetes 1.34) with
[Envoy Gateway](https://gateway.envoyproxy.io/) 1.9 as the Gateway API implementation;
[`examples/deploy-kubernetes/`](../examples/deploy-kubernetes/) runs it there with the starter
project.

Before applying it:

- `image` is the image you built from the recipe.
- `gatewayClassName` is the GatewayClass your Gateway API implementation installs.
- `graphoria-tls` is a `kubernetes.io/tls` Secret with the certificate for `api.example.com`, from
  your certificate issuer or `kubectl create secret tls graphoria-tls --cert <crt> --key <key>`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: graphoria
type: Opaque
stringData:
  ADMIN_SECRET: replace-me # openssl rand -hex 32
  JWT_SECRET: replace-me # needed with auth or the console on
  PG_HOST: postgres.example.internal # whatever your graphoria.ts reads
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: graphoria
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  selector:
    matchLabels: { app: graphoria }
  template:
    metadata:
      labels: { app: graphoria }
    spec:
      # preStop 5 s + SHUTDOWN_TIMEOUT_MS 8 s + 1 s of teardown, with room to spare.
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: graphoria
          image: registry.example.com/my-app:1.0.0
          ports:
            - { name: http, containerPort: 3000 }
          envFrom:
            - secretRef: { name: graphoria }
          env:
            - { name: RATE_LIMIT_TRUST_PROXY, value: "true" }
          startupProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 5
            # 100 s: DB_CONNECT_RETRY_MS (60 s) plus one connectionTimeout (30 s), with margin.
            failureThreshold: 20
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 10
          lifecycle:
            preStop:
              # Keeps serving while the endpoint removal reaches the gateway.
              sleep: { seconds: 5 }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            # Nothing is written at run time; PRINT_SCHEMAS would need a volume.
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
---
apiVersion: v1
kind: Service
metadata:
  name: graphoria
spec:
  selector: { app: graphoria }
  ports:
    - { name: http, port: 80, targetPort: http }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: graphoria
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: graphoria }
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: graphoria
spec:
  gatewayClassName: eg # your implementation's GatewayClass
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: api.example.com
      tls:
        mode: Terminate
        certificateRefs: [{ name: graphoria-tls }]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: graphoria
spec:
  parentRefs: [{ name: graphoria }]
  hostnames: [api.example.com]
  # Only the public API: /health, /metrics, /_console, /openapi.json and /mcp stay in the cluster.
  # Two rules, so that a policy can reach the requests without the websocket upgrade.
  rules:
    - name: websocket
      matches:
        - path: { type: Exact, value: /graphql }
          method: GET
      backendRefs: [{ name: graphoria, port: 80 }]
    - name: api
      matches:
        - path: { type: Exact, value: /graphql }
        - path: { type: PathPrefix, value: /rest }
      backendRefs: [{ name: graphoria, port: 80 }]
```

Why each part is there:

- **Probes.** The startup probe covers boot, however long the database takes, up to the retry
  window. Liveness then checks only that the process answers; readiness checks every dependency,
  with `timeoutSeconds` above the 2 seconds each check is allowed. See
  [Kubernetes](./OBSERVABILITY.md#kubernetes) for what the endpoints check.
- **`preStop` and the grace period** follow [Graceful shutdown](#graceful-shutdown). The `sleep`
  action needs Kubernetes 1.30 or later
  ([container lifecycle hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/));
  before that, `exec: { command: ["sleep", "5"] }` does the same, since the image has `sleep`.
- **Security context.** The recipe's `bun` user, uid `1000`, with no privilege escalation, no
  capabilities and a read-only root filesystem.
- **Scaling.** Size `replicas` against [Database connections](#database-connections), with
  `maxSurge` in the sum. Beyond one replica the per-process caveats in
  [Processes and sizing](#processes-and-sizing) apply.

Measured on kind: both replicas ready about 7 seconds after the apply; `kubectl delete pod` returns
after about 6 seconds (the 5-second `preStop`, then a drain that exits `0` with
`shutdown complete {"clean":true}` in the logs), not 30; with the database stopped during a
rollout, the new pods waited and became ready once it came back, with no restart.

### With Envoy Gateway

Three settings sit outside the Gateway API and need your implementation's own resources. These are
Envoy Gateway's; with another implementation, find its way to do each.

```yaml
# The client address: drop any X-Forwarded-For the client sent, so the one Envoy adds is the
# leftmost entry.
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: graphoria
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: graphoria
  headers:
    earlyRequestHeaders:
      remove: [X-Forwarded-For]
---
# Upstream keep-alive below the server's 10 s idle timeout (Envoy's default is 1 hour).
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: graphoria
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: graphoria
  timeout:
    http:
      connectionIdleTimeout: 5s
---
# A 1 MiB body limit on the api rule only: buffering breaks the websocket upgrade. A policy on a
# rule replaces the one on its route, so it repeats the keep-alive.
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: graphoria-api
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: graphoria
      sectionName: api
  timeout:
    http:
      connectionIdleTimeout: 5s
  requestBuffer:
    limit: 1Mi
```

Measured with Envoy Gateway 1.9: without the `ClientTrafficPolicy` a client-sent
`X-Forwarded-For` became `actor.ip`, with it the gateway's own entry did; a 2 MB request got a
`413` while the websocket still connected, and the same buffer on the whole route broke the
websocket upgrade; and an idle subscription socket stayed open for the 7 minutes measured, past
Envoy's 15-second route timeout and its 5-minute stream idle timeout, with no timeout setting on
the route.

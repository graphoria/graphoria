# Admin Console

A built-in web UI showing the current state of a running Graphoria server: exposed tables and columns, roles and their permissions, runtime status (databases, queues, cron), and the resolved configuration.

## Enabling

The console is **off by default**. Enable it via environment variables:

```bash
CONSOLE_ENABLED=true
# optional, defaults to /_console
CONSOLE_ENDPOINT=/_console
# optional, how long a console session lasts. Defaults to 1h
CONSOLE_SESSION_EXPIRES_IN=1h
```

Open `http://localhost:3000/_console` and enter the server's admin secret (`ADMIN_SECRET`).

## Sessions

The secret is posted once to `POST {CONSOLE_ENDPOINT}/api/login`, which exchanges it for a **session cookie** — `graphoria_console_session`, `httpOnly`, `Secure`, `SameSite=Strict`, scoped to `CONSOLE_ENDPOINT`. The browser attaches it to every subsequent console request on its own; no JavaScript on the page can read it, and the admin secret itself is never stored client-side.

The session is a token signed by the configured token strategy (`jwt`, `paseto_local` or `paseto_public`) carrying `aud: "console"`, so it cannot be used as an API access token and an access token cannot be used as a console session. It expires after `CONSOLE_SESSION_EXPIRES_IN`; there is no refresh, so the console asks for the secret again.

`POST {CONSOLE_ENDPOINT}/api/logout` revokes the session immediately and clears the cookie.

Two consequences worth knowing:

- **The cookie is `Secure`**, so the console needs HTTPS, or `localhost` — browsers treat `http://localhost` as a secure context but will drop the cookie over plain HTTP on any other host.
- **Revocation is per process.** The console keeps its revoked session IDs in memory rather than in the Redis token store, so it works without Redis; the trade-off is that in cluster mode a logout is honoured by the worker that served it and by no other. Keep `CONSOLE_SESSION_EXPIRES_IN` short if you run more than one worker.

## Pages

| Page   | Shows                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables | Every table/view exposed to the superadmin role: columns (with descriptions, types, nullability), relationships (source→target with `resolverName`), and a deep link into GraphiQL pre-filled with the table name.              |
| Roles  | Cross-role permission matrix (which role sees which entity), per-role entity browser (tables+columns, operations, remote schemas, remote REST), and per-role SDL viewer/download.                                               |
| APIs   | REST operations (method + path + tag), remote REST proxies, remote GraphQL schemas, with deep links into Scalar (per-operation anchor) and the `openapi.json` spec.                                                             |
| Status | Uptime, memory, Bun version, PID, token strategy, per-database ping latency, queue broker connections, publishers/subscribers, cron jobs with trigger/pause/resume controls, and a queue publish form. Auto-refreshes every 5s. |
| Config | Project name/version, endpoint prefixes (linked), enabled features (auth, AI, MCP, CORS).                                                                                                                                       |

## API

The UI is backed by JSON endpoints under `{CONSOLE_ENDPOINT}/api`:

| Endpoint                   | Auth    | Returns                                                                                                                                                                     |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`          | none    | Exchange the admin secret for a session cookie. Body: `{ "secret": "<ADMIN_SECRET>" }`. Returns `{ "expiresIn": <seconds> }`, or `401` for a wrong secret.                  |
| `POST /api/logout`         | none    | Revoke the caller's session and clear the cookie. Always `200`.                                                                                                             |
| `GET /api/meta`            | none    | Project name and version.                                                                                                                                                   |
| `GET /api/tables`          | session | Tables with columns (name, type, nullable, description) and relationships (schema, name, source→target columns).                                                            |
| `GET /api/roles`           | session | Role list + raw permission configuration.                                                                                                                                   |
| `GET /api/roles/entities`  | session | `?role=<name>` → that role's resolvable tables (with column names), operations (method+path), remote schemas, and remote REST APIs (`400` for unknown roles).               |
| `GET /api/apis`            | session | REST operations (name, method, path, tag), remote REST APIs (name, prefix, base URL, route count), remote GraphQL schemas (name, prefix, URL, query/mutation field counts). |
| `GET /api/schema`          | session | `?role=<name>` → that role's GraphQL SDL (`400` for unknown roles).                                                                                                         |
| `GET /api/status`          | session | Uptime, memory (RSS), Bun version, PID, token strategy, per-database ping latency, publishers, subscribers (name+topic), queue connections, cron job summary.               |
| `POST /api/queues/publish` | session | Publish a message to a queue. Body: `{ "publisher": "<name>", "message": "<string \| object>", "key": "<routing-key>?" }`.                                                  |
| `POST /api/cron`           | session | Control a cron job. Body: `{ "name": "<job-name>", "action": "trigger" \| "pause" \| "resume" }`.                                                                           |
| `GET /api/config`          | session | Project name/version, endpoint prefixes, feature flags (auth, AI, MCP, CORS).                                                                                               |

Authenticated endpoints answer `404` for any request without a live console session — expired, revoked, forged, or absent alike. The session cookie is the **only** accepted credential: the admin-secret header (`ADMIN_SECRET_HEADER`) is not honoured here, so a script calling these endpoints must `POST /api/login` first and carry the cookie it returns. `/api/meta` is unauthenticated so the UI can render before login; it exposes only the project name and version.

## Security notes

- Never expose the console publicly without network-level protection: the admin secret grants full RBAC bypass.
- The admin secret is sent once, over the login request, and never stored in `localStorage`, `sessionStorage`, or anywhere else JavaScript can read. A session cookie is what rides subsequent requests, and it expires and can be revoked.
- Nothing rate-limits `POST /api/login`. Put the console behind network-level protection and give `ADMIN_SECRET` enough entropy to survive online guessing.
- Status responses contain database **names and engine types only** — never connection credentials.

## Replaces the superadmin REST endpoints

The console replaces the former `/_superadmin/rest` endpoints (`GET /`, `POST /metadata`, `POST /tables`) and the `SUPERADMIN_REST_ENABLE` / `SUPERADMIN_REST_API_PREFIX` environment variables. `/api/roles` and `/api/tables` are their successors.

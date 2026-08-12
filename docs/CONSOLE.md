# Admin Console

A built-in web UI showing the current state of a running Graphoria server: exposed tables and columns, roles and their permissions, runtime status (databases, queues, cron), and the resolved configuration.

## Enabling

The console is **off by default**. Enable it via environment variables:

```bash
CONSOLE_ENABLED=true
# optional, defaults to /_console
CONSOLE_ENDPOINT=/_console
```

Open `http://localhost:3000/_console` and enter the server's admin secret (`ADMIN_SECRET`). The secret is stored in the browser's `localStorage` and sent on every API request via the admin-secret header (`ADMIN_SECRET_HEADER`, default `x-admin-secret`).

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

| Endpoint                   | Auth         | Returns                                                                                                                                                                     |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------ |
| `GET /api/meta`            | none         | Project name, version, admin-secret header name.                                                                                                                            |
| `GET /api/tables`          | admin secret | Tables with columns (name, type, nullable, description) and relationships (schema, name, source→target columns).                                                            |
| `GET /api/roles`           | admin secret | Role list + raw permission configuration.                                                                                                                                   |
| `GET /api/roles/entities`  | admin secret | `?role=<name>` → that role's resolvable tables (with column names), operations (method+path), remote schemas, and remote REST APIs (`400` for unknown roles).               |
| `GET /api/apis`            | admin secret | REST operations (name, method, path, tag), remote REST APIs (name, prefix, base URL, route count), remote GraphQL schemas (name, prefix, URL, query/mutation field counts). |
| `GET /api/schema`          | admin secret | `?role=<name>` → that role's GraphQL SDL (`400` for unknown roles).                                                                                                         |
| `GET /api/status`          | admin secret | Uptime, memory (RSS), Bun version, PID, token strategy, per-database ping latency, publishers, subscribers (name+topic), queue connections, cron job summary.               |
| `POST /api/queues/publish` | admin secret | Publish a message to a queue. Body: `{ "publisher": "<name>", "message": "<string                                                                                           | object>", "key": "<routing-key>?" }`. |
| `POST /api/cron`           | admin secret | Control a cron job. Body: `{ "name": "<job-name>", "action": "trigger"                                                                                                      | "pause"                               | "resume" }`. |
| `GET /api/config`          | admin secret | Project name/version, endpoint prefixes, feature flags (auth, AI, MCP, CORS).                                                                                               |

Authenticated endpoints answer `404` for any non-superadmin session (same gating as the rest of the server: the admin secret maps to the superadmin role). `/api/meta` is unauthenticated so the UI can discover the configured header name; it exposes only the project name, version, and header name.

## Security notes

- Never expose the console publicly without network-level protection: the admin secret grants full RBAC bypass.
- Status responses contain database **names and engine types only** — never connection credentials.

## Replaces the superadmin REST endpoints

The console replaces the former `/_superadmin/rest` endpoints (`GET /`, `POST /metadata`, `POST /tables`) and the `SUPERADMIN_REST_ENABLE` / `SUPERADMIN_REST_API_PREFIX` environment variables. `/api/roles` and `/api/tables` are their successors.

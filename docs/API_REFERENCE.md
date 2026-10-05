# API Reference

> **See also:** [Configuration Reference](./CONFIGURATION.md) | [Permissions & Access Control](./PERMISSIONS.md)

Complete exports reference for all Graphoria packages.

---

## @graphoria/server

Main server package. Two export paths: `.` (the server runtime) and `./config` (configuration helpers + types — `operation`, `cron`, `queue`, virtual-column builders, `z`, `ConfigurationFn`). Installing `@graphoria/server` alone is enough, except for queues and AI: the RabbitMQ and Kafka adapters ship in `@graphoria/queues` (see [Installing the adapters](./QUEUES.md#installing-the-adapters)) and the AI agent + MCP runtimes in `@graphoria/ai` (see [Installing](./AI.md#installing)).

### Main Export (`.`)

Import: `import { createBunServer, createHandlers, createGraphQLEngine } from "@graphoria/server"`

#### `createBunServer(options?)`

Creates and starts a Bun HTTP server with all routes configured. It also installs SIGTERM and SIGINT handlers that shut the server down gracefully — see [Graceful shutdown](#graceful-shutdown).

```typescript
async function createBunServer(options?: Partial<Env>): Promise<{
  server: Bun.Server;
  prefixes: Prefixes;
  logger: (name: string) => pino.Logger;
  execute: Execute;
  shutdown: () => Promise<boolean>; // `shutdown(server)`, bound to this server
}>;
```

#### `createHandlers(options?)`

Creates server handlers without starting a server. Useful for custom server setups.

```typescript
async function createHandlers(options?: Partial<Env>): Promise<{
  serverHandlers: {
    port: number;
    websocket: WebSocketHandler;
    routes: RoutesMap;
  };
  options: Env;
  prefixes: Prefixes;
  logger: (name: string) => pino.Logger;
  execute: Execute;
  shutdown: (server: Bun.Server) => Promise<boolean>;
  handleSignals: (server: Bun.Server) => void;
}>;
```

`createHandlers` installs no signal handler: hand the server you start to `handleSignals`.

```typescript
const { serverHandlers, handleSignals } = await createHandlers();
handleSignals(Bun.serve(serverHandlers));
```

#### Graceful shutdown

`shutdown(server)` stops the server and releases everything the handlers opened, in this order:

1. The listener closes, so new connections are refused. Every open websocket gets a `1001` close ("server shutting down"), and cron schedules no new run.
2. Requests in flight get up to `SHUTDOWN_TIMEOUT_MS` (default `8000`) to finish. Past that, the connections left are reset.
3. The queue connections close, then both Redis clients, then the database pools, and last the spans still queued are flushed. This teardown gets one second.

It runs once: a later call returns the first call's promise. It resolves `true` when the drain finished in time and every step succeeded, `false` otherwise, and never exits the process. A cron job already running when the pools close fails with a pool error.

`handleSignals(server)` runs `shutdown(server)` on the first SIGTERM or SIGINT, then exits `0` when it resolved `true` and `1` otherwise. A second signal exits `1` at once. Calling it again installs nothing more.

`createBunServer` calls `handleSignals` on its server. To keep the signals for your own code, set `SHUTDOWN_HANDLE_SIGNALS=false`, or pass `shutdown` in the options — with both fields, since options replace a whole `Env` key:

```typescript
const { shutdown } = await createBunServer({
  shutdown: { timeoutMs: 8000, handleSignals: false },
});

process.on("SIGTERM", async () => {
  process.exit((await shutdown()) ? 0 : 1);
});
```

Until the server listens there is nothing to drain: a SIGTERM or SIGINT received while `createBunServer` is still booting — waiting for the database, say — exits `0` at once, and so does one sent to a `graphoria` CLI worker. `SHUTDOWN_HANDLE_SIGNALS=false` turns this off with the rest. `createHandlers` installs nothing during boot either; the signals stay yours.

The `graphoria` CLI supervises its server processes: it restarts one that crashes (after 1 s, doubling up to 30 s), stops at the 5th crash within 60 s with a non-zero exit, and on SIGTERM, SIGINT or SIGHUP stops every worker and exits `0` when all of them stopped cleanly.

#### `createGraphQLEngine(env)`

Run GraphQL queries in-process, without an HTTP server. Performs the same boot as `createBunServer` minus the route / websocket / queue / cron layer: no queue connects, and a publish from an operation handler answers `false`.

```typescript
async function createGraphQLEngine(env: Partial<Env>): Promise<{
  execute: Execute;
  roles: string[];
  close: () => Promise<void>; // releases database connections
  logger: (name: string) => pino.Logger;
}>;
```

#### `Execute`

The in-process query runner returned by all three factories above. It runs the same introspection / no-data / validation / dispatch pipeline as the `/graphql` endpoint.

```typescript
type Execute = (
  query: string,
  variables?: Record<string, unknown>,
  opts?: { role?: string; session?: SessionContext },
) => Promise<unknown>;
```

`execute` **bypasses authentication** — there is no token verification. `opts.role` selects the role and defaults to the superadmin role (full privileges), so do not expose it to untrusted input. Because no `BunRequest` exists, operation `init`/`beforeRequest` hooks and header-derived session variables do not run.

#### Prefixes

`createBunServer` and `createHandlers` return a `prefixes` object:

```typescript
type Prefixes = {
  graphql: string; // e.g. "/graphql"
  graphiql: string; // e.g. "/graphiql"
  scalar: string; // e.g. "/scalar"
  rest: string; // e.g. "/rest"
  openapi: string; // e.g. "/openapi.json"
  console: string; // e.g. "/_console" — mounted only when CONSOLE_ENABLED
  health: string; // e.g. "/health" — serves /health/live and /health/ready
  metrics: string; // e.g. "/metrics" — mounted only when METRICS_ENABLED
};
```

#### `configureLogging(loggerOrOptions)`

Inject a custom pino logger or options before any `logger` call. First call wins — subsequent calls are ignored.

```typescript
function configureLogging(loggerOrOptions: pino.Logger | pino.LoggerOptions): void;
```

```typescript
import { configureLogging } from "@graphoria/server";
import pino from "pino";

// Pass a pre-configured pino instance
configureLogging(pino({ level: "trace", redact: ["req.headers.authorization"] }));

// Or pass pino options
configureLogging({ level: "trace" });
```

All internal components (queues, cron, auth, cache, etc.) use child loggers with a `component` binding — filterable in log aggregators.

All three server factories also return `logger` so application code can log through the same pino root (honoring any `configureLogging` / `Env.logger` override) without re-importing:

```typescript
const { server, logger } = await createBunServer();
const log = logger("my-feature"); // child logger bound to { component: "my-feature" }
log.info("ready");
```

#### `Env.logger`

The `Env` type accepts an optional `logger` field. Pass it to `createBunServer`, `createHandlers`, or `createGraphQLEngine` — it calls `configureLogging` internally.

```typescript
type Env = {
  // ... all env-var-driven fields ...
  logger?: pino.Logger | pino.LoggerOptions;
};
```

#### `setQueueAdapter(type, adapter)`

Registers the adapter for a queue type (`"rabbitmq"` or `"kafka"`) before boot. A registered adapter wins over the one discovered from `@graphoria/queues`. See [QUEUES.md](./QUEUES.md#adapter-interface).

```typescript
function setQueueAdapter(type: QueueAdapterType, adapter: QueueAdapter): void;
```

The adapter types are exported with it: `QueueAdapter`, `QueueAdapterType`, `QueueManager` (what `start` resolves to), `QueueConnectionStatus`, `QueuePublisher`, `QueueRuntimeContext`, and `QueueConfig` / `RabbitMQConfig` / `KafkaConfig` — the parsed shape an adapter receives (`exchanges` / `queues`), not the `QueueConfig` you write in `graphoria.ts` (that one comes from `./config`).

### Config Export (`./config`)

Import: `import { operation, cron, queue, z, virtualColumnExpression, ... } from "@graphoria/server/config"`

`@graphoria/server/config` is the configuration-authoring surface: all helpers + types (including `ConfigurationFn`) plus the server-only `RepositoryMap` / `DatabasesConnections` types. The exhaustive export tables are [below](#exported-types).

#### `operation(config)`

Define a typed operation (query-based or handler-based). See [CONFIGURATION.md](./CONFIGURATION.md#operations).

```typescript
// Query-based
operation({ query: "...", rest: { path: "/..." } })

// Handler-based
operation({ handler: async (options, input) => { ... }, input: z.object({...}) })

// With typed repository (generic is the DB-keyed map; access repository[dbName])
operation.typed<{ main: MyRepo }>()({ handler: async (options, input) => { ... }, input: z.object({...}) })
```

#### `cron(config)`

Define a typed cron job with Zod validation.

```typescript
cron({ name: "cleanup", pattern: "0 2 * * *", query: "mutation { ... }" });
```

#### `queue`

Queue configuration helpers:

```typescript
queue.rabbitmq({ name: "main", connection: "amqp://localhost", ... })
queue.kafka({ name: "events", connection: { brokers: ["localhost:9092"] }, ... })
```

#### Virtual Column Helpers

```typescript
virtualColumnExpression(name, dataType, isNullable, expression): VirtualColumnType
virtualColumnFunction(name, dataType, isNullable, functionName, params?): VirtualColumnType
createOneToBooleanMSSQL(columnName): VirtualColumnType
createYAndNToBooleanMSSQL(columnName): VirtualColumnType
```

#### `z`

Re-exported Zod library for convenience.

#### Exported Types

| Export                        | Description                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ConfigurationFn`             | Type for the configuration function `(helpers) => ConfigurationInput`                                |
| `ConfigurationHelpers`        | Type for the helpers object (`z`, `operation`, virtual column fns)                                   |
| `ConfigurationInput`          | Full configuration shape                                                                             |
| `OperationFn`                 | Type for the `operation()` helper (`typeof operation`: 2 overloads + `.typed`)                       |
| `TypedOperation`              | Union of `QueryOperation` and `HandlerOperation`                                                     |
| `OperationHandler`            | `(options, input) => output` handler function type                                                   |
| `OperationOptions`            | `{ gqlQuery, databases, queues, repository }` passed to handlers                                     |
| `DefaultInput`                | `Record<string, unknown>` — default input type when no schema provided                               |
| `BaseOperation`               | Shared fields: description, input, output, hooks, rest, graphql, cache                               |
| `QueryOperation`              | Operation with `query` field                                                                         |
| `HandlerOperation`            | Operation with `handler` field                                                                       |
| `OperationRestConfig`         | REST exposure config: path, method, pathParams, queryParams, body                                    |
| `OperationGraphQLConfig`      | GraphQL exposure config: enabled, name                                                               |
| `OperationCacheConfig`        | LRU cache config: max, ttl, maxSize, etc.                                                            |
| `OperationInitHook`           | `(options) => initData` hook type                                                                    |
| `OperationBeforeRequestHook`  | `(context, initData) => variables` hook type                                                         |
| `OperationAfterRequestHook`   | `(context) => output` hook type                                                                      |
| `BeforeRequestContext`        | `{ input; pathParams?; queryParams?; body? }` — merged input + per-source REST params                |
| `AfterRequestContext`         | `{ output: TOutput }`                                                                                |
| `GqlQueryResult`              | `{ data: T; errors?: unknown[] }`                                                                    |
| `DatabaseType`                | `"pg" \| "mssql" \| "mysql" \| "sqlite"`                                                             |
| `DatabaseConnection`          | `ServerConnection \| SQLiteConnection`                                                               |
| `ServerConnection`            | `{ host, port, user, password, database }` — pg/mysql/mssql connection shape                         |
| `SQLiteConnection`            | `{ filename, attach? }` — SQLite database files                                                      |
| `ConnectionForType`           | Maps a `DatabaseType` to its `connection` shape                                                      |
| `DatabaseConfig`              | Full database config with generics per type                                                          |
| `DatabaseSchemaConfig`        | Schema config: database table overrides, excludedTables                                              |
| `TableSchemaConfig`           | Per-table: virtual columns, relationships, description + columnDescriptions overrides                |
| `TableRelationship`           | `{ schema, name, columns: [{ source, target }] }`                                                    |
| `CustomRepositoryFactory`     | `(connection) => T` — typed per database type                                                        |
| `AnyDatabaseConfig`           | Discriminated union of all `DatabaseConfig<T>` variants                                              |
| `AuthConfig`                  | `{ enabled, database, schema?, permissions? }`                                                       |
| `MCPConfig`                   | `{ enabled }` — MCP server config, nested under `AIConfig.mcp`. See MCP.md.                          |
| `AIConfig`                    | `{ enabled, systemPrompt?, endpoint?, mcp? }` — AI agent (granted per role) + MCP. See AI.md.        |
| `AiPackage`                   | The `@graphoria/ai` runtime seam: `AiToolDeps`, `Agent`, `AgentCaller`, `ToolCaller`, `McpCaller`.   |
| `RolePermission`              | `{ tables?, storedProcedures?, queues?, operations?, remoteSchemas?, remoteREST?, ai?, rateLimit? }` |
| `TablePermission`             | `{ columns, filter?, orderBy? }`                                                                     |
| `FilterCondition`             | `Record<string, Record<string, unknown>>`                                                            |
| `DirectionUnion`              | `"ASC" \| "DESC" \| "ASC_NULLS_FIRST" \| ...`                                                        |
| `OrderByClause`               | `{ column: string; direction: DirectionUnion }`                                                      |
| `QueueConfig`                 | `RabbitMQConfig \| KafkaConfig`                                                                      |
| `RabbitMQConfig`              | RabbitMQ connection + publishers/subscribers/topics                                                  |
| `KafkaConfig`                 | Kafka connection + publishers/subscribers/topics                                                     |
| `PublisherConfig`             | `{ topic, routingKey?, persistent?, headers? }`                                                      |
| `SubscriberConfig`            | `{ topic, pattern?, queue?, group?, handler? }`                                                      |
| `SubscriberHandler`           | `(message, { cache }) => void`                                                                       |
| `CacheContext`                | `{ invalidate: (operationName, pattern?) => boolean }`                                               |
| `TopicConfig`                 | `{ type?, durable?, autoDelete? }`                                                                   |
| `CronJobConfig`               | Full cron job config                                                                                 |
| `CronTickCallback`            | `(options, context, response?) => void`                                                              |
| `VirtualColumnType`           | `{ name, dataType, isNullable, virtual?, function?, params?, expression? }`                          |
| `VirtualColumnFunctionFn`     | Function signature for `virtualColumnFunction`                                                       |
| `VirtualColumnExpressionFn`   | Function signature for `virtualColumnExpression`                                                     |
| `CreateOneToBooleanMSSQLFn`   | Function signature for `createOneToBooleanMSSQL`                                                     |
| `CreateYAndNToBooleanMSSQLFn` | Function signature for `createYAndNToBooleanMSSQL`                                                   |

#### Exported Helpers

| Export                      | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `operation`                 | Operation definition helper (runtime)                                           |
| `cron`                      | Cron job definition helper with Zod validation (runtime)                        |
| `queue`                     | `{ rabbitmq, kafka }` builders that add the `type` discriminator (runtime)      |
| `virtualColumnExpression`   | Build an expression-backed virtual column (runtime)                             |
| `virtualColumnFunction`     | Build a function-backed virtual column (runtime)                                |
| `createOneToBooleanMSSQL`   | MSSQL `1/0` → boolean virtual column (runtime)                                  |
| `createYAndNToBooleanMSSQL` | MSSQL `Y/N` → boolean virtual column (runtime)                                  |
| `z`                         | Re-exported Zod library                                                         |
| `createApiResponse`         | `(dataSchema) => z.object({ status: z.string(), data: dataSchema.optional() })` |

#### Type Inference Utilities

```typescript
type InferOperationInput<T>    // Extract TInput from a TypedOperation
type InferOperationOutput<T>   // Extract TOutput from a TypedOperation
type InferOperationInitData<T> // Extract TInitData from a TypedOperation
```

#### Cron Types

| Export                   | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `TypedCronJob`           | Cron job type with typed variables                                   |
| `TickContext`            | `{ name, pattern, variables, executionCount, nextRun, previousRun }` |
| `DefaultVariables`       | `Record<string, unknown>`                                            |
| `CronJobType`            | Zod-inferred cron job input type                                     |
| `DefaultVariablesSchema` | Zod schema for default variables                                     |
| `createTypedCronJobZod`  | Factory for typed cron job Zod schemas                               |
| `TypedCronJobZod`        | Default cron job Zod schema                                          |

#### Zod Schemas

| Export                      | Description                   |
| --------------------------- | ----------------------------- |
| `OperationRestConfigZod`    | Zod schema for REST config    |
| `OperationGraphQLConfigZod` | Zod schema for GraphQL config |
| `OperationCacheConfigZod`   | Zod schema for cache config   |
| `ServerConnectionZod`       | Schema for ServerConnection   |
| `SQLiteConnectionZod`       | Schema for SQLiteConnection   |

---

## @graphoria/react

Client-agnostic React hooks and components for authentication and role-based access control. Bring your own GraphQL client (Apollo, urql, relay, raw fetch) and wire it via the exported token-store API.

Import: `import { AppProvider, useAuth, Authorize } from "@graphoria/react"`

### Components

#### `AppProvider`

Top-level provider combining authentication and route-based access control.

```typescript
function AppProvider<TRole extends string = string>(props: {
  children: ReactNode;
  routeConfig: RouteConfig<TRole>;
  onAuthChange?: (user: { role: TRole } | null) => void;
  onLogout?: () => void | Promise<void>;
  onTokenRefresh?: (accessToken: string, expiresIn: number) => void;
  loadingFallback?: ReactNode;
  httpUri?: string; // Default: "/graphql"
  includeCredentials?: boolean; // Default: true
}): JSX.Element;
```

Renders: `AuthProvider` > `RouteConfigContext.Provider`. Wrap your GraphQL client's provider _inside_ `AppProvider` so it can read tokens via `getAccessToken()`.

#### `AuthProvider`

Authentication context provider. Manages JWT/PASETO token lifecycle with proactive refresh.

```typescript
function AuthProvider<TRole extends string = string>(props: {
  children: ReactNode;
  onAuthChange?: (user: User<TRole> | null) => void;
  onLogout?: () => void | Promise<void>;
  onTokenRefresh?: (accessToken: string, expiresIn: number) => void;
  loadingFallback?: ReactNode;
  httpUri?: string; // Default: "/graphql"
  includeCredentials?: boolean; // Default: true
}): JSX.Element;
```

#### `Authorize`

Renders children when the current user has any of the listed roles. `fallback` (default `null`) renders otherwise.

```typescript
function Authorize<TRole extends string = string>(props: {
  roles: TRole[];
  fallback?: ReactNode;
  children: ReactNode;
}): JSX.Element;
```

#### `Authenticated` / `Unauthenticated`

Render children based on auth state. `fallback` (default `null`) renders otherwise.

```typescript
function Authenticated(props: { fallback?: ReactNode; children: ReactNode }): JSX.Element;
function Unauthenticated(props: { fallback?: ReactNode; children: ReactNode }): JSX.Element;
```

### Hooks

#### `useAuth()`

Access authentication state and actions.

```typescript
function useAuth<TRole extends string = string>(): AuthContextType<TRole>;
```

Returns:

| Field                       | Type                    | Description                        |
| --------------------------- | ----------------------- | ---------------------------------- |
| `isAuthenticated`           | `boolean`               | Whether user is logged in          |
| `isLoading`                 | `boolean`               | Whether auth state is initializing |
| `user`                      | `User<TRole> \| null`   | Current user (role)                |
| `error`                     | `string \| null`        | Last auth error                    |
| `login(username, password)` | `Promise<User \| null>` | Log in                             |
| `logout()`                  | `Promise<void>`         | Log out                            |
| `hasRole(role)`             | `boolean`               | Check exact role                   |
| `hasAnyRole(roles)`         | `boolean`               | Check if user has any of the roles |
| `refreshToken()`            | `Promise<boolean>`      | Manually trigger token refresh     |

#### `useRouteConfig()`

Access route configuration and permission helpers.

```typescript
function useRouteConfig<TRole extends string = string>(): RouteConfigContextType<TRole>;
```

Returns:

| Field                              | Type                 | Description                            |
| ---------------------------------- | -------------------- | -------------------------------------- |
| `config`                           | `RouteConfig<TRole>` | The route config passed to AppProvider |
| `isProtectedRoute(path)`           | `boolean`            | Whether path requires authentication   |
| `getRequiredRoles(path)`           | `TRole[] \| null`    | Required roles, or null for public     |
| `canRoleAccess(path, role)`        | `boolean`            | Whether role can access path           |
| `getRedirectPath(role, returnTo?)` | `string`             | Default route for role                 |

#### `useCanAccess(path)`

Check if the current user can access a specific path.

```typescript
function useCanAccess(path: string): boolean;
```

### Token store

Module-level helpers for wiring your GraphQL client to the SDK's token lifecycle.

```typescript
function getAccessToken(): string | null;
function setAccessToken(token: string | null): void;
function subscribeAccessToken(cb: (token: string | null) => void): () => void;
function ensureFreshToken(): Promise<boolean>;
```

- `getAccessToken()` — synchronous read of the in-memory access token. Use in your auth link / fetch wrapper.
- `setAccessToken(token)` — set/clear the in-memory token. The SDK calls this internally on login/refresh/logout.
- `subscribeAccessToken(cb)` — subscribe to token changes (returns unsubscribe). Use to restart a WebSocket on rotation.
- `ensureFreshToken()` — single-flight refresh, deduplicates concurrent callers, triggers logout on failure. Call from your client's 401 handler.

### Errors

#### `GraphQLFetchError`

Thrown by the built-in auth fetch on non-OK responses or GraphQL errors. Carries `status`, `body`, and `errors` fields.

### Types

```typescript
interface User<TRole extends string = string> {
  role: TRole;
}

interface AuthState<TRole extends string = string> {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User<TRole> | null;
  error: string | null;
}

interface AuthContextType<TRole extends string = string> extends AuthState<TRole> {
  login: (username: string, password: string) => Promise<User<TRole> | null>;
  logout: () => Promise<void>;
  hasRole: (role: TRole) => boolean;
  hasAnyRole: (roles: TRole[]) => boolean;
  refreshToken: () => Promise<boolean>;
}

interface TokenResponse<TRole extends string = string> {
  access_token: string;
  expires_in: number; // seconds
  role: TRole;
}

interface RouteConfig<TRole extends string = string> {
  permissions: Record<string, TRole[] | null>; // null = public
  defaultRoutes: Partial<Record<TRole, string>>;
  fallbackRoute: string;
}

interface RouteConfigContextType<TRole extends string = string> {
  config: RouteConfig<TRole>;
  isProtectedRoute: (path: string) => boolean;
  getRequiredRoles: (path: string) => TRole[] | null;
  canRoleAccess: (path: string, role: TRole | null) => boolean;
  getRedirectPath: (role: TRole, returnTo?: string) => string;
}

interface AuthTransportOptions {
  httpUri?: string; // Default: "/graphql"
  includeCredentials?: boolean; // Default: true
}
```

### Key Patterns

- **In-memory token storage**: Access tokens stored in memory (not localStorage) for XSS protection. Recovered on reload via `auth_refresh` if the server set the `httpOnly` refresh cookie.
- **Proactive refresh**: Tokens refreshed ~30 seconds before `expires_in` elapses.
- **401 recovery**: `ensureFreshToken()` is the reactive fallback — call it from your client's error handler when a request fails with 401, then retry.
- **Client-agnostic**: The SDK doesn't ship a GraphQL client or own a WebSocket connection. Your client owns transport; the SDK owns auth state and exposes hooks for both sides to stay in sync.

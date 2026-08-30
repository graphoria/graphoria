# Configuration Reference

> **See also:** [Permissions & Access Control](./PERMISSIONS.md) | [API Reference](./API_REFERENCE.md)

Full reference for the Graphoria configuration file. Configuration is defined as a function that receives helpers and returns a `ConfigurationInput` object.

```typescript
import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ z, operation, cron, virtualColumnExpression, virtualColumnFunction }) => ({
  name: "My API",
  version: "1.0.0",
  databases: [...],
  auth: { ... },
  operations: { ... },
  queues: [...],
  cron: [...],
})) satisfies ConfigurationFn;
```

## Environment Variables

All secrets and runtime knobs are set via environment variables. Bun auto-loads `.env`.

| Variable         | Type     | Default                       | Notes                                                                                                                                       |
| ---------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`      | `string` | `debug` (dev) / `info` (prod) | pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`                                                                          |
| `NODE_ENV`       | `string` | `DEVELOPMENT`                 | `PRODUCTION` disables pino-pretty formatting                                                                                                |
| `MAX_QUERY_COST` | `number` | `0`                           | Estimated cost ceiling for a caller's query. `0` is off — see [Bounding how much one query asks for](#bounding-how-much-one-query-asks-for) |

See [`.env.example`](../.env.example) for the full list.

See also: [Logging](#logging) in the README and `configureLogging` in the [API Reference](./API_REFERENCE.md).

---

## ConfigurationInput

```typescript
type ConfigurationInput = {
  name: string;
  version: string;
  /**
   * Token strategy for authentication.
   * "jwt" (default) | "paseto_local" | "paseto_public"
   * See AUTHENTICATION.md for the env vars each strategy requires.
   */
  tokenStrategy?: "jwt" | "paseto_local" | "paseto_public";
  databases: AnyDatabaseConfig[];
  auth?: AuthConfig;
  operations?: Record<string, TypedOperation<any, any, any, any>>;
  queues?: QueueConfig[];
  cron?: CronJobConfig[];
  /** External GraphQL schemas to merge in. See REMOTE_SCHEMAS.md. */
  remoteSchemas?: RemoteSchemaConfig[];
  /** External REST APIs (OpenAPI) to proxy under /rest. See REMOTE_REST.md. */
  remoteREST?: RemoteRESTConfig[];
  /** Admin-only AI agent (NL → database Q&A) + MCP server. Off by default. */
  ai?: {
    enabled: boolean;
    systemPrompt?: string;
    endpoint?: string;
    /** Model Context Protocol server. Off by default. See MCP.md. */
    mcp?: { enabled: boolean };
  };
};
```

---

## Boot-time validation

The configuration is validated in two passes, both of which stop the server from
starting rather than letting it come up misconfigured.

**Shape**, before anything connects: an unknown key is rejected, so a typo in a
key name fails immediately instead of being dropped.

**References**, once the databases have been introspected: every name the
configuration points at is resolved against what exists, and any that resolve to
nothing are reported together with their config path and the closest name that
does exist.

| Reference                                               | Resolved against                             |
| ------------------------------------------------------- | -------------------------------------------- |
| `auth.permissions.<role>.tables` keys                   | introspected tables and views                |
| `…tables.<table>.columns`, `filter` keys, `orderBy`     | that table's columns, relations for nesting  |
| `auth.permissions.<role>.storedProcedures`              | introspected stored procedures               |
| `auth.permissions.<role>.queues`                        | `queues[].name`                              |
| `auth.permissions.<role>.operations`                    | `operations` keys                            |
| `auth.permissions.<role>.remoteSchemas` / `remoteREST`  | `remoteSchemas[].name` / `remoteREST[].name` |
| `queues[].publishers` / `subscribers` `.topic`          | that queue's `topics` keys                   |
| `databases[].schema.excludedTables` and `database` keys | that database's tables and views             |

```
Configuration references 2 names that do not exist:
  - auth.permissions.user.tables.orderz — no table or view named "orderz" (did you mean "orders"?)
  - queues[0].publishers.placed.topic — no topic named "order" (did you mean "orders"?)
```

This exists because these names all fail closed on their own: a permission
naming a table that is not there drops the entry, so the rule never applies and
nothing says so.

---

## Databases

Each entry in the `databases` array configures a database connection. The `type` field determines the available connection types.

### DatabaseConfig

```typescript
type DatabaseConfig<T extends DatabaseType = DatabaseType> = {
  name: string; // Unique identifier
  enabled: boolean; // Whether this database is active
  type: T; // "pg" | "mssql" | "mysql"
  connection: DatabaseConnection; // Connection details
  connectionOptions?: ConnectionOptionsForType<T>; // Pool and transport tuning
  fieldNaming?: string; // Resolver name pattern (default: "{schema}_{name}")
  repository?: CustomRepositoryFactory<T>; // Custom repository factory
  onConnect?: OnConnectHandler<T>; // Handler run once at startup against the connection
  schema?: DatabaseSchemaConfig; // Virtual columns, relationships, excluded tables
};
```

### DatabaseConnection

```typescript
type DatabaseConnection = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};
```

### ConnectionOptions

Pool and transport tuning. Optional. The shape depends on `type`: `pg` and `mysql` go through Bun's built-in SQL client, `mssql` through the `mssql` package. All timeouts are in seconds.

The defaults below are the ones validation fills in, and they apply whether or not you supply `connectionOptions` — with two exceptions on MSSQL; see [When connectionOptions is absent](#when-connectionoptions-is-absent).

```typescript
// type: "pg" | "mysql"
type BunSQLConnectionOptions = {
  max?: number; // Maximum connections in the pool (default: 10)
  idleTimeout?: number; // Seconds a connection may sit idle before closing (default: 30)
  connectionTimeout?: number; // Seconds to wait when establishing a connection (default: 30)
  maxLifetime?: number; // Maximum lifetime of a connection (default: 3600)
  tls?: boolean; // Use TLS/SSL (default: false)
  allowPublicKeyRetrieval?: boolean; // MySQL only, see below (default: false)
  prepare?: boolean; // Create prepared statements automatically (default: true)
  bigint?: boolean; // Return values outside i32 range as BigInt, not string (default: false)
};

// type: "mssql"
type MSSQLConnectionOptions = {
  pool?: {
    max?: number; // Maximum connections in the pool (default: 10)
    min?: number; // Minimum connections in the pool (default: 0)
    idleTimeout?: number; // Seconds a connection may sit idle before closing (default: 30)
    acquireTimeout?: number; // Seconds to wait for a free connection when saturated (default: 30)
  };
  connectionTimeout?: number; // Seconds to wait when establishing a connection (default: 30)
  requestTimeout?: number; // Seconds to wait for a request to complete (default: QUERY_TIMEOUT_MS)
  encrypt?: boolean; // Encrypt the connection (default: false)
  trustServerCertificate?: boolean; // Trust the server certificate unvalidated (default: false)
  trustedConnection?: boolean; // Use Windows Authentication (default: false)
  parseJSON?: boolean; // Parse JSON responses automatically (default: true)
};
```

#### When connectionOptions is absent

The key is optional, and every pool bound above applies either way — the pool is built from the same defaults whether you supply the key or leave it out.

Two MSSQL transport flags are the exception, and they are the ones to watch:

| Option                           | supplied | absent   |
| -------------------------------- | -------- | -------- |
| `trustServerCertificate` (mssql) | false    | **true** |
| `trustedConnection` (mssql)      | false    | **true** |

With no `connectionOptions`, the server certificate is trusted without being validated. Set any MSSQL option and validation fills `trustServerCertificate` with `false`, which will drop a connection to a server presenting a self-signed certificate. Set the fields you depend on explicitly rather than relying on either column.

One sharp edge behind that: `connectionOptions` is validated against an undiscriminated union of the two shapes, so the engine does not pick the schema — the object's own fields do. An object carrying nothing engine-specific, `{}` included, matches the `pg`/`mysql` shape even on an `mssql` database, which is why those two flags still read from the object rather than from the validated result. Any MSSQL-only field (`requestTimeout`, `pool`, `encrypt`, …) routes it to the right shape.

#### Bounding the wait for a connection

`pool.acquireTimeout` caps how long a request waits for a free connection when the pool is saturated, so a slow-query storm fails callers instead of queueing them behind it. It is **MSSQL only** — Bun's SQL client, which backs `pg` and `mysql`, exposes no equivalent. Its `connectionTimeout` bounds opening a connection, not waiting for one.

#### Bounding how long a statement runs

`QUERY_TIMEOUT_MS` aborts a statement that has run longer than it, in milliseconds, defaulting to `10000`. `0` disables it and logs a warning at boot. The bound is applied by the database, so the statement really stops — a client that merely gave up would still be holding the connection and every lock the statement had taken.

Each engine enforces it the only way it can:

| Engine  | Mechanism                                                       | Covers                                                        |
| ------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| `pg`    | `statement_timeout`, set on every connection in the pool        | every statement, generated queries and auth and introspection |
| `mssql` | `requestTimeout` on the pool, an attention packet when it fires | every request                                                 |
| `mysql` | a `MAX_EXECUTION_TIME` hint on the generated statement          | generated queries only — see below                            |

**MySQL is bounded only where the hint reaches.** Bun's MySQL adapter ignores per-connection runtime settings and offers no hook to run one when a pooled connection opens, so there is no pool-level route on that engine. Auth logins, schema introspection and stored-procedure `CALL`s do not go through query generation and are therefore **not** bounded on MySQL. They are on `pg` and `mssql`.

On MSSQL, `connectionOptions.requestTimeout` wins when you set it explicitly — `QUERY_TIMEOUT_MS` only fills the value in when the key is absent — so a pool deliberately raised for a slow report keeps its bound. Note that the two use different units: `requestTimeout` is in seconds, `QUERY_TIMEOUT_MS` in milliseconds.

A single operation can override all of the above with its own `timeout`; see [Operations](./OPERATIONS.md#statement-timeout).

#### Bounding how much one query asks for

`MAX_QUERY_COST` caps the estimated cost of a caller's query, rejecting it before it executes. It **ships off** — `0`, the default, means nothing is estimated and no warning fires at boot to say so. Read this section as the warning.

It exists because depth and page size leave a shape uncovered. Depth bounds how deep a selection nests, `MAX_PAGE_SIZE` bounds one list field, and a query that is merely _wide_ passes both: a hundred sibling relationships under one root list, each paged at the default, is a legal eight-deep query that asks for a million rows.

The estimate is a walk of the parsed document against the role's schema:

```
cost(field) = 1 + multiplier(field) × Σ cost(child)
```

`multiplier` is the page size the field asks for — its `limit` argument, resolved through the request's variables, falling back to `DEFAULT_PAGE_SIZE` when there is none — for a list field, and `1` for anything returning a single row: a scalar, a to-one relationship, a `_single` field. A relationship carries no extra weight of its own; the multiplier already encodes the fan-out a join causes. Fragment spreads are expanded, so moving a fan-out into a fragment does not hide it. Introspection meta-fields are skipped. A document carrying several operations is scored by its most expensive one.

At the default `DEFAULT_PAGE_SIZE` of `100`:

| Query                                                  | Cost         |
| ------------------------------------------------------ | ------------ |
| `tasks(limit: 20) { id title project { id name } }`    | `101`        |
| A dashboard: one unbounded root list, seven scalars    | `701`        |
| Three unbounded nested to-many lists, one scalar each  | `1 020 201`  |
| One root list × 1000 to-many siblings, one scalar each | `10 100 001` |

Four orders of magnitude separate a realistic query from a wide one, which is what makes a single scalar budget workable. **`100000` is the recommended starting value**: it clears both realistic queries with two orders of magnitude to spare and rejects both attack shapes.

It also rejects three unbounded nested to-many lists, and that is the one rejection an operator will see and assume is a bug. It is not: three unbounded to-many levels really is a million rows. The fix is for the caller to pass a `limit`.

Over budget answers a validation error naming both numbers:

```
Estimated query cost of 1020201 exceeds the maximum allowed cost of 100000 (operation: "Dashboard"). Raise MAX_QUERY_COST to allow more expensive queries.
```

Two limits of the estimate, both deliberate:

- **It is a guess outside table-backed fields.** `DEFAULT_PAGE_SIZE` is applied by Graphoria's SQL builder to tables. The cost walk is driven by schema shape, so it also charges a default multiplier to a list field backed by a remote schema or an operation, where Graphoria pages nothing and the real row count is whatever the upstream returns. An estimate there, not a bound.
- **Operator-authored queries are exempt**, alongside the existing depth exemption. REST operations take their text from the configuration, never from a caller, so a budget there could only turn an operator's own query into a dead route.

There is no MCP-specific override. MCP gets its own `AI_MCP_MAX_QUERY_DEPTH` because an agent legitimately writes deeper queries than an application does; nothing makes the same argument for asking a database for more rows.

#### MySQL over a plain connection

MySQL 8 authenticates with `caching_sha2_password`. Whenever the server has no cached password for the user — a fresh server, a restarted container, a new account — it falls back to full authentication, which asks the client to fetch the server's RSA public key. Bun refuses to do that over an unencrypted connection, and the pool never opens:

```
MySQLError: The server requested RSA public key retrieval to complete authentication,
which is not allowed over an insecure connection. Enable TLS or set allowPublicKeyRetrieval: true
```

Two ways out, in order of preference:

- `tls: true` — with an encrypted transport there is no key to retrieve.
- `allowPublicKeyRetrieval: true` — for a server reachable only over plain TCP. It is off by default because without TLS a man-in-the-middle can answer with a key of its own and read the password, so keep it to trusted networks.

```typescript
{
  name: "default",
  enabled: true,
  type: "mysql",
  connection: { host: "127.0.0.1", port: 3306, user: "root", password: "…", database: "app" },
  connectionOptions: { allowPublicKeyRetrieval: true },
}
```

### DatabaseSchemaConfig

```typescript
type DatabaseSchemaConfig = {
  database?: Record<string, TableSchemaConfig>; // Key: "{schema}_{tableName}"
  excludedTables?: string[];
};

type TableSchemaConfig = {
  columns?: VirtualColumnType[];
  relationships?: TableRelationship[];
  description?: string; // Overrides the table description from the database
  columnDescriptions?: Record<string, string>; // Overrides column descriptions, keyed by column name
};
```

`excludedTables` matches the table name in any case. `database` keys must match
exactly, because two tables can differ only in case and an override has to pick
one of them. Both are resolved at boot — see [Boot-time validation](#boot-time-validation).

#### Description overrides

By default table and column descriptions come from the database (PostgreSQL comments,
MSSQL `MS_Description` extended properties). Override them from configuration — useful
when the database has cryptic names but no comments, or when you can't alter the schema.
Config always wins over the database value. Column keys are matched case-insensitively;
keys that match no column are ignored.

```typescript
schema: {
  database: {
    public_users: {
      description: "Application user accounts",
      columnDescriptions: {
        id: "Primary key",
        email: "Login email, unique",
      },
    },
  },
}
```

Overridden descriptions surface in the generated GraphQL SDL (as field/type descriptions)
and in the MCP `describe_entity` / `list_entities` tools.

### Custom Repository

The `repository` factory receives a typed connection based on the database type:

- `"pg"` / `"mysql"` → `SQL` (Bun native)
- `"mssql"` → `ConnectionPool` (mssql package)

```typescript
databases: [
  {
    name: "main",
    type: "pg",
    enabled: true,
    connection: {
      host: "localhost",
      port: 5432,
      user: "user",
      password: "pass",
      database: "db",
    },
    repository: (sql) => ({
      // sql is typed as SQL (Bun native)
      getActiveUsers: () => sql`SELECT * FROM users WHERE active = true`,
    }),
  },
];
```

### Startup Handler (`onConnect`)

`onConnect` runs once at boot, after the connection is established and before the
`repository` factory. It receives the same typed connection as `repository`
(`SQL` for `pg`/`mysql`, `ConnectionPool` for `mssql`) plus the database config.
Use it to run startup SQL such as creating tables. If it throws, the server
fails to start.

```typescript
databases: [
  {
    name: "main",
    type: "pg",
    enabled: true,
    connection: {
      host: "localhost",
      port: 5432,
      user: "user",
      password: "pass",
      database: "db",
    },
    onConnect: async (sql) => {
      await sql`CREATE TABLE IF NOT EXISTS audit_log (id serial primary key, message text)`;
    },
  },
];
```

### Relationships

```typescript
type TableRelationship = {
  schema: string;
  name: string;
  columns: Array<{ source: string; target: string }>;
  conditions?: RelationshipCondition[];
};

// Static-value predicate ANDed into the JOIN. Set exactly one of `source`
// (a column on the declaring table) or `target` (a column on the referenced
// table). `value` is required unless `operator` is `is_null` / `is_not_null`.
type RelationshipCondition = {
  source?: string;
  target?: string;
  operator?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "is_null" | "is_not_null"; // default "eq"
  value?: string | number | boolean;
};
```

Example:

```typescript
schema: {
  database: {
    public_orders: {
      relationships: [
        { schema: "public", name: "users", columns: [{ source: "user_id", target: "id" }] },
      ],
    },
  },
}
```

#### Static join conditions

Use `conditions` to constrain a relationship with fixed values on top of the column match. Each entry targets one side of the relationship — `source` (declaring table) or `target` (referenced table) — and is ANDed into the JOIN. This is useful when a lookup table is shared across entity kinds and you only want to join the rows of a given type:

```typescript
schema: {
  database: {
    dbo_EDITORIAL_MESSAGE: {
      relationships: [
        {
          schema: "dbo",
          name: "Types",
          columns: [{ source: "EDT_TYPE", target: "TypeCode" }],
          // ON EDITORIAL_MESSAGE.EDT_TYPE = Types.TypeCode AND Types.Type = 'editorial'
          conditions: [{ target: "Type", value: "editorial" }],
        },
      ],
    },
  },
}
```

Values are rendered as SQL literals (strings quoted and escaped, booleans emitted per dialect), so no user input is bound here — keep `value` fixed in config.

---

## Virtual Columns

Virtual columns are computed columns that don't exist in the database but are generated at query time.

### Expression-Based

```typescript
virtualColumnExpression(name, dataType, isNullable, expression);
```

```typescript
virtualColumnExpression("full_name", "varchar", true, "first_name || ' ' || last_name");
```

### Function-Based

```typescript
virtualColumnFunction(name, dataType, isNullable, functionName, params?)
```

```typescript
virtualColumnFunction("age", "int", false, "DATEDIFF", ["YEAR", "birth_date", "GETDATE()"]);
```

### MSSQL Boolean Helpers

Convert MSSQL `1/0` or `Y/N` columns to boolean:

```typescript
createOneToBooleanMSSQL("is_active"); // 1 → true, 0 → false
createYAndNToBooleanMSSQL("has_access"); // "Y" → true, "N" → false
```

---

## Auth

```typescript
type AuthConfig = {
  enabled: boolean;
  database: string; // Database name where auth tables are stored
  schema?: string; // Schema for auth tables (default: "auth")
  permissions?: Record<string, RolePermission>;
};
```

### RolePermission

```typescript
type RolePermission = {
  tables?: "ALL" | string[] | Record<string, "ALL" | TablePermission>;
  storedProcedures?: "ALL" | string[];
  queues?: "ALL" | string[];
  operations?: "ALL" | string[];
  remoteSchemas?: "ALL" | string[];
  remoteREST?: "ALL" | string[];
  rateLimit?: { max: number; windowMs?: number };
};

type TablePermission = {
  columns: "ALL" | string[];
  filter?: FilterCondition;
  orderBy?: OrderByClause[];
};
```

### Rate limiting

Off by default. Nothing is limited until you set a ceiling, and no warning fires at boot to say so — read this section as the warning.

| Variable                   | Type      | Default | Notes                                                       |
| -------------------------- | --------- | ------- | ----------------------------------------------------------- |
| `RATE_LIMIT_MAX`           | `number`  | `0`     | Requests per window for an authenticated caller. `0` is off |
| `RATE_LIMIT_ANONYMOUS_MAX` | `number`  | `0`     | Same, for the anonymous role. `0` is off                    |
| `RATE_LIMIT_WINDOW_MS`     | `number`  | `60000` | Window length in milliseconds                               |
| `RATE_LIMIT_TRUST_PROXY`   | `boolean` | `false` | Read the client address from `X-Forwarded-For`              |

A caller gets one token bucket across every endpoint — `/graphql` (queries and the websocket upgrade alike), `/rest/*`, `/ai`, `/mcp` and the console login — because what exhausts a server is total request volume, not volume on one route. An idle bucket refills to `max`, so a caller may burst `max` and then sustain `max` per window. Over budget is `429` with `Retry-After` in seconds.

Callers are identified by authenticated subject where there is one, and by client address otherwise. **Neither the admin secret nor the superadmin role is exempt** — set `RATE_LIMIT_MAX` above what your own tooling needs. The console polls status every five seconds.

A role may carry its own ceiling, which beats both env values:

```typescript
auth: {
  permissions: {
    anonymous: { tables: "ALL", rateLimit: { max: 60 } },
    admin: { tables: "ALL", rateLimit: { max: 600, windowMs: 10000 } },
  },
}
```

Resolution runs role config → `RATE_LIMIT_ANONYMOUS_MAX` for the anonymous role → `RATE_LIMIT_MAX`. A role entry works while both env values are `0`, which is how you throttle anonymous callers and nobody else. `max: 0` on a role opts that role out.

Four things to know before you rely on it:

- **The store follows `CACHE_STORE`.** With `redis` the bucket lives in Redis and every worker shares it; with `memory` each worker keeps its own, so **the effective limit in cluster mode is your ceiling times the worker count**. Redis is the correct configuration for cluster mode. It is never required.
- **A Redis outage fails open.** Requests are served unlimited while the store is unreachable, and one warning per window says so. The alternative turns a cache blip into an outage.
- **`RATE_LIMIT_TRUST_PROXY` is only as trustworthy as the proxy.** Turn it on and the client address comes from a header the caller can set; on a directly-exposed server that makes the limit decorative. Leave it off unless a proxy you control overwrites `X-Forwarded-For`.
- **It does nothing about a distributed flood.** Per-caller buckets slow one host, not a botnet. That belongs at the edge.

### FilterCondition

Operator-based filter matching the GraphQL `where` argument structure:

```typescript
type FilterCondition = Record<string, Record<string, unknown>>;
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `is_null`, `not_null`.

```typescript
filter: {
  status: { eq: "active" },
  price: { gte: 10, lte: 1000 },
  userId: { eq: "$session.sub" },           // Session variable
  departmentId: { in: "$session.departments" },
  deletedAt: { is_null: true },
}
```

### OrderByClause

```typescript
type DirectionUnion =
  "ASC" | "DESC" | "ASC_NULLS_FIRST" | "ASC_NULLS_LAST" | "DESC_NULLS_FIRST" | "DESC_NULLS_LAST";

type OrderByClause = {
  column: string;
  direction: DirectionUnion;
};
```

See [Permissions & Access Control](./PERMISSIONS.md) for full documentation on filtering, ordering, and session variables.

---

## Operations

Operations are custom endpoints exposed via both GraphQL and REST. Two kinds: **query-based** (wraps a GraphQL query) and **handler-based** (custom function).

### Query-Based Operation

```typescript
operations: {
  getActiveProducts: operation({
    query: `query { products(where: { status: { eq: "active" } }) { id name price } }`,
    description: "Get all active products",
    rest: { path: "/products/active" },
  }),
}
```

### Handler-Based Operation

```typescript
operations: {
  createOrder: operation({
    input: z.object({
      productId: z.string(),
      quantity: z.number().int().positive(),
    }),
    output: z.object({
      orderId: z.string(),
      total: z.number(),
    }),
    handler: async (options, input) => {
      // options.gqlQuery, options.databases, options.queues, options.repository
      const result = await options.gqlQuery(`mutation { ... }`, { ...input });
      return { orderId: "...", total: 0 };
    },
    rest: { path: "/orders", method: "POST" },
  }),
}
```

### Typed Repository Access

Use `operation.typed<T>()` to get typed access to the repository in the handler. The generic is the **databases map**, keyed by database name, and `options.repository[dbName]` is typed accordingly:

```typescript
type MyRepo = { getUser: (id: string) => Promise<User> };

operations: {
  getUser: operation.typed<{ main: MyRepo }>()({
    input: z.object({ id: z.string() }),
    handler: async (options, input) => {
      return options.repository.main.getUser(input.id); // typed!
    },
    rest: { path: "/users/:id" },
  }),
}
```

### Operation Hooks

```typescript
operation({
  query: `query($id: String!) { user(where: { id: { eq: $id } }) { id name } }`,
  input: z.object({ id: z.string() }),
  hooks: {
    init: async (options) => {
      // Called once at startup. Return init data.
      return { cache: new Map() };
    },
    beforeRequest: (context, initData) => {
      // Transform input → query variables. `context.input` is the merged view;
      // `context.pathParams` / `context.queryParams` / `context.body` expose the
      // individual REST sources, each typed from its `rest.*` schema.
      return { id: context.input.id };
    },
    afterRequest: (context) => {
      // Transform the output payload. For this query operation `context.output`
      // is the unwrapped GraphQL `data`; the return replaces `data` in the response.
      return context.output;
    },
  },
});
```

### REST Configuration

```typescript
type OperationRestConfig = {
  path: string;
  description?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathParams?: z.ZodType;
  queryParams?: z.ZodType;
  body?: z.ZodType;
};
```

### GraphQL Configuration

```typescript
type OperationGraphQLConfig = {
  enabled?: boolean; // default: true
  name?: string; // override the GraphQL field name
};
```

### Cache Configuration

```typescript
type OperationCacheConfig = {
  max?: number;
  maxSize?: number;
  ttl?: number; // milliseconds
  allowStale?: boolean;
  updateAgeOnGet?: boolean;
  updateAgeOnHas?: boolean;
  ttlAutopurge?: boolean;
};
```

---

## Queues

Message queue configuration for RabbitMQ and Kafka.

### RabbitMQ

```typescript
import { queue } from "@graphoria/server/config";

queues: [
  queue.rabbitmq({
    name: "main",
    connection: "amqp://localhost",
    // or: connection: { hostname: "localhost", port: 5672, username: "guest", password: "guest", vhost: "/" },
    autoSetup: true,
    publishers: {
      orderCreated: {
        topic: "orders",
        routingKey: "order.created",
        persistent: true,
      },
    },
    subscribers: {
      onOrderCreated: {
        topic: "orders",
        pattern: "order.*",
        handler: async (message, { cache }) => {
          cache.invalidate("getOrders");
        },
      },
    },
    topics: {
      orders: { type: "topic", durable: true },
    },
  }),
];
```

### Kafka

```typescript
queues: [
  queue.kafka({
    name: "events",
    connection: { brokers: ["localhost:9092"], clientId: "my-app" },
    publishers: {
      userEvent: { topic: "user-events" },
    },
    subscribers: {
      onUserEvent: { topic: "user-events", group: "my-group" },
    },
  }),
];
```

### Reconnect Configuration

Both queue types support reconnection:

```typescript
reconnect: {
  initialDelay: 1000,   // ms
  maxDelay: 30000,       // ms
  multiplier: 2,
  maxAttempts: 10,
}
```

---

## Cron Jobs

Scheduled jobs with optional GraphQL query execution.

Declare cron jobs as plain objects in the `cron` array — they're typed by
`ConfigurationFn`, so `onTick` and every other field is checked for you. See
[CRON.md](./CRON.md) for the full tick-callback reference.

```typescript
cron: [
  {
    name: "cleanup",
    pattern: "0 2 * * *", // Every day at 2 AM
    timezone: "America/New_York",
    query: `mutation { deleteExpiredSessions { affected_rows } }`,
    onTick: async (options, context, response) => {
      console.log(`Cleaned up ${response?.data?.deleteExpiredSessions?.affected_rows} sessions`);
    },
  },
  {
    name: "healthCheck",
    pattern: "*/5 * * * *", // Every 5 minutes
    protect: true, // Over-run protection
    maxRuns: 100,
    onTick: async (options, context) => {
      // options.gqlQuery, options.databases, options.queues, options.repository
      // context.name, context.pattern, context.executionCount, context.nextRun
    },
  },
];
```

### CronJobConfig

```typescript
type CronJobConfig<TVariables = Record<string, unknown>> = {
  name: string;
  pattern: string; // Cron expression or ISO 8601 date
  query?: string; // GraphQL query to execute
  variables?: TVariables;
  timezone?: string;
  paused?: boolean;
  maxRuns?: number;
  interval?: number; // Minimum seconds between triggers
  startAt?: string; // ISO 8601 datetime
  stopAt?: string; // ISO 8601 datetime
  protect?: boolean; // Over-run protection
  catchErrors?: boolean; // Default true — log tick errors instead of rethrowing
  context?: Record<string, unknown>; // Passed through to the job instance
  onTick?: CronTickCallback<TVariables>;
};
```

---

## Configuration Helpers

The configuration function receives a `ConfigurationHelpers` object:

```typescript
type ConfigurationHelpers = {
  z: typeof z; // Zod library
  operation: OperationFn; // Operation helper
  createOneToBooleanMSSQL: CreateOneToBooleanMSSQLFn;
  createYAndNToBooleanMSSQL: CreateYAndNToBooleanMSSQLFn;
  virtualColumnExpression: VirtualColumnExpressionFn;
  virtualColumnFunction: VirtualColumnFunctionFn;
};
```

For standalone usage (outside the config function), import helpers directly:

```typescript
import { operation, cron, z } from "@graphoria/server/config";
```

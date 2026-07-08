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

| Variable    | Type     | Default                       | Notes                                                              |
| ----------- | -------- | ----------------------------- | ------------------------------------------------------------------ |
| `LOG_LEVEL` | `string` | `debug` (dev) / `info` (prod) | pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV`  | `string` | `DEVELOPMENT`                 | `PRODUCTION` disables pino-pretty formatting                       |

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

## Databases

Each entry in the `databases` array configures a database connection. The `type` field determines the available connection types.

### DatabaseConfig

```typescript
type DatabaseConfig<T extends DatabaseType = DatabaseType> = {
  name: string; // Unique identifier
  enabled: boolean; // Whether this database is active
  type: T; // "pg" | "mssql" | "mysql"
  connection: DatabaseConnection; // Connection details
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
    connection: { host: "localhost", port: 5432, user: "user", password: "pass", database: "db" },
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
    connection: { host: "localhost", port: 5432, user: "user", password: "pass", database: "db" },
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
};

type TablePermission = {
  columns: "ALL" | string[];
  filter?: FilterCondition;
  orderBy?: OrderByClause[];
};
```

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
  | "ASC"
  | "DESC"
  | "ASC_NULLS_FIRST"
  | "ASC_NULLS_LAST"
  | "DESC_NULLS_FIRST"
  | "DESC_NULLS_LAST";

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
      // Transform input → query variables
      return { id: context.input.id };
    },
    afterRequest: (context) => {
      // Transform query output
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
      orderCreated: { topic: "orders", routingKey: "order.created", persistent: true },
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

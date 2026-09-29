import { z } from "zod";

import type { SQL } from "bun";
import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { ConnectionPool } from "mssql";

import { VirtualColumnZod } from "./virtual-columns";

// ============================================================================
// Base Zod Schemas for Database Configuration
// ============================================================================
// These are the base schemas — the single source of truth for database config
// authoring types. Introspection-only schemas (TableZod, DatabaseStructureZod,
// etc.) stay in types/zod/db.ts.

// ============================================================================
// Database Type
// ============================================================================

const DatabaseTypeZod = z.union([
  z.literal("mssql"),
  z.literal("pg"),
  z.literal("mysql"),
  z.literal("sqlite"),
]);

export type DatabaseType = z.infer<typeof DatabaseTypeZod>;

/** The engines reached over the network, as opposed to SQLite's files. */
const ServerDatabaseTypeZod = z.enum(["mssql", "pg", "mysql"]);

// ============================================================================
// Relationship Join Condition (static-value predicate)
// ============================================================================

/** Comparison operators allowed in a static relationship join condition. */
export const RELATIONSHIP_CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "is_null",
  "is_not_null",
] as const;

/**
 * A static-value predicate added to a relationship's JOIN. Targets exactly one
 * side of the relationship — `source` (a column on the declaring table) or
 * `target` (a column on the referenced table) — and compares it to a literal.
 * A `value` is required for every operator except `is_null` / `is_not_null`.
 */
export const RelationshipConditionZod = z
  .strictObject({
    /** Column on the declaring (source) table */
    source: z.string().optional(),
    /** Column on the referenced (target) table */
    target: z.string().optional(),
    /** Comparison operator (default `eq`) */
    operator: z.enum(RELATIONSHIP_CONDITION_OPERATORS).optional().default("eq"),
    /** Literal compared against the column (omit for `is_null` / `is_not_null`) */
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /**
     * Column on an ancestor table, compared against this condition's column
     * instead of a literal. The ancestor must sit above the relationship in the
     * query path; the nearest match wins, and a query that does not traverse it
     * is rejected rather than joined without the predicate.
     */
    ancestor: z
      .strictObject({ schema: z.string(), name: z.string(), column: z.string() })
      .optional(),
  })
  .refine((cond) => (cond.source === undefined) !== (cond.target === undefined), {
    message: 'Relationship condition must set exactly one of "source" or "target"',
  })
  .refine(
    (cond) =>
      cond.operator === "is_null" || cond.operator === "is_not_null"
        ? cond.ancestor === undefined
        : (cond.value === undefined) !== (cond.ancestor === undefined),
    {
      message:
        'Relationship condition requires exactly one of "value" or "ancestor", and neither operand may be an "ancestor" when operator is is_null/is_not_null',
    },
  );

export type RelationshipCondition = z.input<typeof RelationshipConditionZod>;

// ============================================================================
// Table Relationship (config shape, no transform)
// ============================================================================

export const TableRelationshipZod = z.strictObject({
  schema: z.string(),
  name: z.string(),
  columns: z.array(z.strictObject({ source: z.string(), target: z.string() })),
  /** Static-value predicates ANDed into the JOIN condition */
  conditions: z.array(RelationshipConditionZod).optional(),
});

export type TableRelationship = z.input<typeof TableRelationshipZod>;

// ============================================================================
// Table Schema Config
// ============================================================================

export const TableSchemaConfigZod = z.strictObject({
  columns: z.array(VirtualColumnZod).optional().default([]),
  relationships: z.array(TableRelationshipZod).optional().default([]),
  /** Overrides the table description from the database */
  description: z.string().optional(),
  /** Overrides column descriptions from the database, keyed by column name */
  columnDescriptions: z.record(z.string(), z.string()).optional().default({}),
});

export type TableSchemaConfig = z.input<typeof TableSchemaConfigZod>;

// ============================================================================
// Database Schema Config
// ============================================================================

export const DatabaseSchemaConfigZod = z.strictObject({
  database: z
    .record(
      z.string(),
      TableSchemaConfigZod.optional()
        .default({
          columns: [],
          relationships: [],
          columnDescriptions: {},
        })
        .catch({
          columns: [],
          relationships: [],
          columnDescriptions: {},
        }),
    )
    .optional()
    .default({}),
  excludedTables: z.array(z.string()).optional().default([]),
});

export type DatabaseSchemaConfig = z.input<typeof DatabaseSchemaConfigZod>;

// ============================================================================
// Connection Options
// ============================================================================

/**
 * Connection pool and transport options for PostgreSQL and MySQL (Bun SQL).
 * All timeout values are in seconds.
 */
export const BunSQLConnectionOptionsZod = z.strictObject({
  /** Maximum number of connections in the pool */
  max: z.number().int().positive().default(10),
  /** Maximum time in seconds a connection can be idle before being closed */
  idleTimeout: z.number().nonnegative().default(30),
  /** Maximum time in seconds to wait when establishing a connection */
  connectionTimeout: z.number().nonnegative().default(30),
  /** Maximum lifetime in seconds of a connection */
  maxLifetime: z.number().nonnegative().default(3600),
  /** Whether to use TLS/SSL for the connection */
  tls: z.boolean().default(false),
  /**
   * MySQL only: allow the client to fetch the server's RSA public key over a
   * plain connection when caching_sha2_password asks for full authentication.
   * Off by default, as it is in Bun: without TLS a man-in-the-middle can answer
   * with its own key and read the password. Needed for MySQL 8 servers that are
   * reachable only over plain TCP.
   */
  allowPublicKeyRetrieval: z.boolean().default(false),
  /** Automatic creation of prepared statements (default: true) */
  prepare: z.boolean().default(true),
  /** Return values outside i32 range as BigInts instead of strings (default: false) */
  bigint: z.boolean().default(false),
});

export type BunSQLConnectionOptions = z.input<typeof BunSQLConnectionOptionsZod>;

/**
 * Connection pool and transport options for MSSQL.
 * All timeout values are in seconds (converted to milliseconds internally).
 */
export const MSSQLConnectionOptionsZod = z.strictObject({
  /** Connection pool options */
  pool: z
    .strictObject({
      /** Maximum number of connections in the pool */
      max: z.number().int().positive().default(10),
      /** Minimum number of connections in the pool */
      min: z.number().int().nonnegative().default(0),
      /** Maximum time in seconds a connection can be idle before being closed */
      idleTimeout: z.number().nonnegative().default(30),
      /**
       * Maximum time in seconds to wait for a free connection when the pool is
       * saturated. Without a bound, a slow-query storm queues callers instead of
       * failing them. Bun's SQL driver exposes no equivalent, so this is MSSQL only.
       */
      acquireTimeout: z.number().positive().default(30),
    })
    .default({
      max: 10,
      min: 0,
      idleTimeout: 30,
      acquireTimeout: 30,
    }),
  /** Maximum time in seconds to wait when establishing a connection */
  connectionTimeout: z.number().nonnegative().default(30),
  /** Maximum time in seconds to wait for a request to complete */
  requestTimeout: z.number().nonnegative().default(30),
  /** Whether to encrypt the connection */
  encrypt: z.boolean().default(false),
  /** Whether to trust the server certificate without validation */
  trustServerCertificate: z.boolean().default(false),
  /** Whether to use Windows Authentication (trusted connection) */
  trustedConnection: z.boolean().default(false),
  /** Whether to automatically parse JSON responses */
  parseJSON: z.boolean().default(true),
});

export type MSSQLConnectionOptions = z.input<typeof MSSQLConnectionOptionsZod>;

// ============================================================================
// Generic Types (hand-written — generics can't be inferred from Zod)
// The `type: "pg"` narrowing of `onConnect` / `repository` is load-bearing.
// ============================================================================

/**
 * Maps database type to the corresponding native connection type.
 * SQL for Bun/PostgreSQL/MySQL, ConnectionPool for MSSQL, bun:sqlite's Database for SQLite.
 */
export type DatabaseConnectionForType<T extends DatabaseType> = T extends "pg" | "mysql"
  ? SQL
  : T extends "mssql"
    ? ConnectionPool
    : T extends "sqlite"
      ? SQLiteDatabase
      : never;

/**
 * Custom repository factory function type.
 * Accepts the native connection typed per engine.
 */
export type CustomRepositoryFactory<T extends DatabaseType = DatabaseType> = (
  connection: DatabaseConnectionForType<T>,
) => unknown;

/**
 * Handler invoked once at startup after the database connection is established.
 * Receives the live connection (typed per engine) and the database config.
 * Throwing aborts server boot.
 */
export type OnConnectHandler<T extends DatabaseType = DatabaseType> = (
  connection: DatabaseConnectionForType<T>,
  db: DatabaseConfig<T>,
) => void | Promise<void>;

/**
 * Maps database type to the corresponding connection options type.
 */
export type ConnectionOptionsForType<T extends DatabaseType> = T extends "pg" | "mysql"
  ? BunSQLConnectionOptions
  : T extends "mssql"
    ? MSSQLConnectionOptions
    : never;

/**
 * Maps database type to the shape of its `connection`.
 */
export type ConnectionForType<T extends DatabaseType> = T extends "sqlite"
  ? SQLiteConnection
  : ServerConnection;

// ============================================================================
// Database Connection Zod Schema
// ============================================================================

/** Where a PostgreSQL, MySQL or SQL Server database is reached. */
export const ServerConnectionZod = z.strictObject({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  password: z.string(),
  database: z.string(),
});

export type ServerConnection = z.input<typeof ServerConnectionZod>;

/**
 * The files a SQLite database lives in. Paths resolve against the working
 * directory, and a missing file is created.
 */
export const SQLiteConnectionZod = z.strictObject({
  /** The main file, served as schema `main` */
  filename: z.string().min(1),
  /** Further files, each attached as the schema its key names */
  attach: z.record(z.string(), z.string().min(1)).optional(),
});

export type SQLiteConnection = z.input<typeof SQLiteConnectionZod>;

// Checked in superRefine rather than by the record's key schema: Zod reports a
// rejected record key as a bare "Invalid key in record", losing the reason.
const ATTACHABLE_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQLITE_OWN_SCHEMAS = new Set(["main", "temp"]);

const databaseFields = {
  /** Unique name for the database connection */
  name: z.string(),
  /** Whether the database is enabled */
  enabled: z.boolean(),
  /** Field naming pattern (default: "{schema}_{name}") */
  fieldNaming: z.string().optional().default("{schema}_{name}"),
  /** Factory function to create custom database repository */
  repository: z.custom<CustomRepositoryFactory>().optional(),
  /** Handler run once at startup against the connected database */
  onConnect: z.custom<OnConnectHandler>().optional(),
  /** Schema configuration (virtual columns, relationships, excluded tables) */
  schema: DatabaseSchemaConfigZod.optional(),
};

// Discriminated on `type`, so a connection is checked against its own engine's
// shape only: an unknown key is reported as that key, not folded into one error
// per shape.
export const DatabaseConnectionZod = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...databaseFields,
      /** Database type */
      type: ServerDatabaseTypeZod,
      /** Connection configuration */
      connection: ServerConnectionZod,
      /** Optional connection pool and transport options */
      connectionOptions: z
        .union([BunSQLConnectionOptionsZod, MSSQLConnectionOptionsZod])
        .optional(),
    }),
    z.strictObject({
      ...databaseFields,
      /** Database type */
      type: z.literal("sqlite"),
      /** The database files */
      connection: SQLiteConnectionZod,
      /** Not accepted: SQLite has no pool or transport to tune */
      connectionOptions: z.undefined().optional(),
    }),
  ])
  .superRefine((db, ctx) => {
    if (db.type !== "sqlite") return;

    for (const schema of Object.keys(db.connection.attach ?? {})) {
      if (!ATTACHABLE_SCHEMA.test(schema) || SQLITE_OWN_SCHEMAS.has(schema.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["connection", "attach", schema],
          message: `"${schema}" is not a schema name SQLite can attach: use letters, digits and _, and not "main" or "temp"`,
        });
      }
    }
  });

// ============================================================================
// Database Config
// ============================================================================

/**
 * Database connection shape (derived from the Zod schema).
 */
export type DatabaseConnection = z.input<typeof DatabaseConnectionZod>["connection"];

/**
 * Database configuration with engine-type narrowing.
 */
export type DatabaseConfig<T extends DatabaseType = DatabaseType> = Omit<
  z.input<typeof DatabaseConnectionZod>,
  "type" | "connection" | "repository" | "onConnect" | "connectionOptions"
> & {
  /** Database type */
  type: T;
  /** Connection configuration */
  connection: ConnectionForType<T>;
  /** Factory function to create custom database repository */
  repository?: CustomRepositoryFactory<T>;
  /** Handler run once at startup against the connected database */
  onConnect?: OnConnectHandler<T>;
  /** Optional connection pool and transport options */
  connectionOptions?: ConnectionOptionsForType<T>;
};

// ============================================================================
// Discriminated Union
// ============================================================================

/**
 * Discriminated union of all database configs — allows proper type narrowing
 * for repository function parameter based on the database type field.
 */
export type AnyDatabaseConfig = {
  [K in DatabaseType]: DatabaseConfig<K>;
}[DatabaseType];

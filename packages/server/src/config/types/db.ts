import { z } from "zod";

import type { SQL } from "bun";
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

export type DatabaseType = "mssql" | "pg" | "mysql";

// ============================================================================
// Table Relationship (config shape, no transform)
// ============================================================================

export const TableRelationshipZod = z.object({
  schema: z.string(),
  name: z.string(),
  columns: z.array(z.object({ source: z.string(), target: z.string() })),
});

export type TableRelationship = z.input<typeof TableRelationshipZod>;

// ============================================================================
// Table Schema Config
// ============================================================================

export const TableSchemaConfigZod = z.object({
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

export const DatabaseSchemaConfigZod = z.object({
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
export const BunSQLConnectionOptionsZod = z.object({
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
export const MSSQLConnectionOptionsZod = z.object({
  /** Connection pool options */
  pool: z
    .object({
      /** Maximum number of connections in the pool */
      max: z.number().int().positive().default(10),
      /** Minimum number of connections in the pool */
      min: z.number().int().nonnegative().default(0),
      /** Maximum time in seconds a connection can be idle before being closed */
      idleTimeout: z.number().nonnegative().default(30),
    })
    .default({
      max: 10,
      min: 0,
      idleTimeout: 30,
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
 * SQL for Bun/PostgreSQL/MySQL, ConnectionPool for MSSQL.
 */
export type DatabaseConnectionForType<T extends DatabaseType> = T extends "pg" | "mysql"
  ? SQL
  : T extends "mssql"
    ? ConnectionPool
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

// ============================================================================
// Database Connection Zod Schema
// ============================================================================

export const DatabaseConnectionZod = z.object({
  /** Unique name for the database connection */
  name: z.string(),
  /** Whether the database is enabled */
  enabled: z.boolean(),
  /** Database type */
  type: z.union([z.literal("mssql"), z.literal("pg"), z.literal("mysql")]),
  /** Connection configuration */
  connection: z.object({
    host: z.string(),
    port: z.number(),
    user: z.string(),
    password: z.string(),
    database: z.string(),
  }),
  /** Field naming pattern (default: "{schema}_{name}") */
  fieldNaming: z.string().optional().default("{schema}_{name}"),
  /** Factory function to create custom database repository */
  repository: z.custom<CustomRepositoryFactory>().optional(),
  /** Handler run once at startup against the connected database */
  onConnect: z.custom<OnConnectHandler>().optional(),
  /** Schema configuration (virtual columns, relationships, excluded tables) */
  schema: DatabaseSchemaConfigZod.optional(),
  /** Optional connection pool and transport options */
  connectionOptions: z.union([BunSQLConnectionOptionsZod, MSSQLConnectionOptionsZod]).optional(),
});

// ============================================================================
// Database Config (hand-written generic wrapper over z.input field inventory)
// The generic `T` narrowing of `onConnect` / `repository` / `connectionOptions`
// is load-bearing — Zod can't express this narrowing.
// ============================================================================

/**
 * Database connection shape (derived from the Zod schema).
 */
export type DatabaseConnection = z.input<typeof DatabaseConnectionZod>["connection"];

/**
 * Database configuration with engine-type narrowing.
 */
export type DatabaseConfig<T extends DatabaseType = DatabaseType> = {
  /** Unique name for the database connection */
  name: string;
  /** Whether the database is enabled */
  enabled: boolean;
  /** Database type */
  type: T;
  /** Connection configuration */
  connection: DatabaseConnection;
  /** Field naming pattern (default: "{schema}_{name}") */
  fieldNaming?: string;
  /** Factory function to create custom database repository */
  repository?: CustomRepositoryFactory<T>;
  /** Handler run once at startup against the connected database */
  onConnect?: OnConnectHandler<T>;
  /** Schema configuration (virtual columns, relationships, excluded tables) */
  schema?: DatabaseSchemaConfig;
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

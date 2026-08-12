import type { RemoteRESTResolved, RemoteRESTRoute } from "../remoteREST/types";
import type { RemoteSchemaResolved } from "../remoteSchemas/types";
import type { Publisher } from "./configuration";
import type { ProcedureResolver, TableResolver } from "./db";
import type { TypedOperation } from "./zod/operation";

/**
 * Entity source types - identifies where a resolver's data comes from
 */
export enum EntitySource {
  /** Database table or view */
  TABLE = "table",
  /** Database stored procedure */
  STORED_PROCEDURE = "stored_procedure",
  /** Message queue (RabbitMQ, Kafka, etc.) */
  QUEUE_PUBLISHER = "queue_publisher",
  /** Authentication mutations (login, refresh, etc.) */
  AUTH = "auth",
  /** Custom operation handlers */
  OPERATION = "operation",
  /** Remote GraphQL schema */
  REMOTE_SCHEMA = "remote_schema",
  /** Remote REST API (OpenAPI) */
  REMOTE_REST = "remote_rest",
  /** AI agent query */
  AI = "ai",
}

/**
 * Base resolver entry with source identification
 */
export type ResolverEntryBase = {
  source: EntitySource;
};

/**
 * Resolver entry for database tables
 */
export type TableResolverEntry = ResolverEntryBase & {
  source: EntitySource.TABLE;
  resolver: TableResolver;
};

/**
 * Resolver entry for stored procedures
 */
export type StoredProcedureResolverEntry = ResolverEntryBase & {
  source: EntitySource.STORED_PROCEDURE;
  resolver: ProcedureResolver;
};

/**
 * Resolver entry for message queues
 */
export type QueueResolverEntry = ResolverEntryBase & {
  source: EntitySource.QUEUE_PUBLISHER;
  resolver: Publisher;
};

/**
 * Resolver entry for authentication operations
 */
export type AuthResolverEntry = ResolverEntryBase & {
  source: EntitySource.AUTH;
  resolver: {
    name: string;
    operation: "login" | "refresh" | "logout" | "register" | "me";
  };
};

/**
 * Resolver entry for custom operations
 */
export type OperationResolverEntry = ResolverEntryBase & {
  source: EntitySource.OPERATION;
  // oxlint-disable-next-line typescript/no-explicit-any
  resolver: TypedOperation<any, any, any>;
};

/**
 * Resolver entry for remote schema fields
 */
export type RemoteSchemaResolverEntry = ResolverEntryBase & {
  source: EntitySource.REMOTE_SCHEMA;
  resolver: {
    remoteSchema: RemoteSchemaResolved;
    originalFieldName: string;
  };
};

/**
 * Resolver entry for remote REST API routes
 */
export type RemoteRESTResolverEntry = ResolverEntryBase & {
  source: EntitySource.REMOTE_REST;
  resolver: {
    remoteREST: RemoteRESTResolved;
    route: RemoteRESTRoute;
  };
};

/**
 * Resolver entry for the AI agent query
 */
export type AIResolverEntry = ResolverEntryBase & {
  source: EntitySource.AI;
  resolver: { name: string };
};

/**
 * Union type of all resolver entries
 */
export type ResolverEntry =
  | TableResolverEntry
  | StoredProcedureResolverEntry
  | QueueResolverEntry
  | AuthResolverEntry
  | OperationResolverEntry
  | RemoteSchemaResolverEntry
  | RemoteRESTResolverEntry
  | AIResolverEntry;

/**
 * Registry type - plain object for fast access
 */
export type ResolverRegistry = Record<string, ResolverEntry>;

/**
 * Helper to create typed resolver entries
 */
export const createResolverEntry = {
  table: (resolver: TableResolver): TableResolverEntry => ({
    source: EntitySource.TABLE,
    resolver,
  }),

  storedProcedure: (resolver: ProcedureResolver): StoredProcedureResolverEntry => ({
    source: EntitySource.STORED_PROCEDURE,
    resolver,
  }),

  queuePublisher: (resolver: Publisher): QueueResolverEntry => ({
    source: EntitySource.QUEUE_PUBLISHER,
    resolver,
  }),

  auth: (
    name: string,
    operation: AuthResolverEntry["resolver"]["operation"],
  ): AuthResolverEntry => ({
    source: EntitySource.AUTH,
    resolver: { name, operation },
  }),

  // oxlint-disable-next-line typescript/no-explicit-any
  operation: (resolver: TypedOperation<unknown, unknown, unknown>): OperationResolverEntry => ({
    source: EntitySource.OPERATION,
    resolver,
  }),

  remoteSchema: (
    remoteSchema: RemoteSchemaResolved,
    originalFieldName: string,
  ): RemoteSchemaResolverEntry => ({
    source: EntitySource.REMOTE_SCHEMA,
    resolver: { remoteSchema, originalFieldName },
  }),

  remoteREST: (
    remoteREST: RemoteRESTResolved,
    route: RemoteRESTRoute,
  ): RemoteRESTResolverEntry => ({
    source: EntitySource.REMOTE_REST,
    resolver: { remoteREST, route },
  }),

  ai: (name: string): AIResolverEntry => ({
    source: EntitySource.AI,
    resolver: { name },
  }),
};

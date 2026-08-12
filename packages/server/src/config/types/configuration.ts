import type { SQL } from "bun";
import type { ConnectionPool } from "mssql";
import { z } from "zod";
import type { AIConfig } from "./ai";
import type { AuthConfig } from "./auth";
import type { CronJobConfig } from "./cron";
import type { AnyDatabaseConfig } from "./db";
import type { TypedOperation } from "./operation";
import type { QueueConfig } from "./queue";
import type { RemoteRESTConfig } from "./remote-rest";
import type { RemoteSchemaConfig } from "./remote-schema";

/**
 * Union of supported database connection types
 */
export type DatabaseConnectionInstance = SQL | ConnectionPool;

// ============================================================================
// Token Strategy
// ============================================================================

/**
 * Token strategy for authentication
 * - "jwt": JSON Web Tokens (default)
 * - "paseto_local": PASETO v4.local (symmetric encryption)
 * - "paseto_public": PASETO v4.public (public-key signatures)
 */
export const TokenStrategyZod = z.enum(["jwt", "paseto_local", "paseto_public"]);

export type TokenStrategy = z.input<typeof TokenStrategyZod>;

// ============================================================================
// Configuration Input Type
// ============================================================================

/**
 * Full configuration input type for Graphoria
 */
export type ConfigurationInput = {
  /** Project name */
  name: string;
  /** Project version */
  version: string;
  /**
   * Token strategy: "jwt" (default), "paseto_local", or "paseto_public"
   *
   * When using PASETO, set the corresponding environment variables:
   * - paseto_local: PASETO_LOCAL_KEY (k4.local.xxx format)
   * - paseto_public: PASETO_SECRET_KEY (k4.secret.xxx) + PASETO_PUBLIC_KEY (k4.public.xxx)
   */
  tokenStrategy?: TokenStrategy;
  /** Database connections */
  databases?: AnyDatabaseConfig[];
  /** Message queues (RabbitMQ, Kafka) */
  queues?: QueueConfig[];
  /** Cron jobs */
  cron?: CronJobConfig[];
  /** Operations - unified handlers for REST + GraphQL */
  // oxlint-disable-next-line typescript/no-explicit-any
  operations?: Record<string, TypedOperation<any, any, any, any>>;
  /** Authentication configuration */
  auth?: AuthConfig;
  /** Remote GraphQL schemas to merge into the API */
  remoteSchemas?: RemoteSchemaConfig[];
  /** Remote REST APIs (OpenAPI) to proxy under /rest */
  remoteREST?: RemoteRESTConfig[];
  /** AI agent (admin-only NL → database Q&A) + MCP server. Off by default. */
  ai?: AIConfig;
};

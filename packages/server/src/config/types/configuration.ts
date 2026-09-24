import type { SQL } from "bun";
import type { ConnectionPool } from "mssql";
import { z } from "zod";
import type { ConfigurationZod } from "../../types/zod/configuration";
import type { CronJobConfig } from "./cron";
import type { AnyDatabaseConfig } from "./db";
import type { TypedOperation } from "./operation";

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
export type ConfigurationInput = Omit<
  z.input<typeof ConfigurationZod>,
  "databases" | "cron" | "operations"
> & {
  /** Database connections */
  databases?: AnyDatabaseConfig[];
  /** Cron jobs */
  cron?: CronJobConfig[];
  /** Operations - unified handlers for REST + GraphQL */
  // oxlint-disable-next-line typescript/no-explicit-any
  operations?: Record<string, TypedOperation<any, any, any, any>>;
};

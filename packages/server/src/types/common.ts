import type { GqlQueryResult } from "../config";
import type { BunRequest } from "bun";
import type { DatabasesConnections, RepositoryMap } from "../singletons/databases";
import type { QueueManager } from "../singletons/queues";

/**
 * GraphQL query function type
 * @param TReqOptional - Whether the request parameter is optional (true for cron jobs, false for operations)
 */
export type GqlQueryFn<TReqOptional extends boolean = false> = TReqOptional extends true
  ? <TReturn = unknown>(
      query: string,
      params?: Record<string, unknown>,
      req?: BunRequest,
    ) => Promise<GqlQueryResult<TReturn>>
  : <TReturn = unknown>(
      query: string,
      params: Record<string, unknown>,
      req: BunRequest,
    ) => Promise<GqlQueryResult<TReturn>>;

/**
 * Base callback options containing gqlQuery and database connections
 * Used by operations, cron jobs, and other callback-based features
 *
 * @param TReqOptional - Whether the request parameter in gqlQuery is optional
 */
export type CallbackOptions<TReqOptional extends boolean = false, TRepository = unknown> = {
  /**
   * Execute a GraphQL query against the server
   */
  gqlQuery: GqlQueryFn<TReqOptional>;
  /**
   * Database connections available for direct database access
   */
  databases: DatabasesConnections;
  /**
   * Queue manager for managing queues
   */
  queues: QueueManager | undefined;
  /**
   * Custom database repository created from repository factory functions.
   * Keys are database names, values are the result of the repository factory.
   * Access with: repository["dbName"] to get the repository for that database.
   */
  repository: RepositoryMap<TRepository>;
};

/**
 * Callback options with required request parameter (for operations, REST handlers)
 */
export type OperationCallbackOptions<TRepository = unknown> = CallbackOptions<false, TRepository>;

/**
 * Callback options with optional request parameter (for cron jobs, background tasks)
 */
export type BackgroundCallbackOptions<TRepository = unknown> = CallbackOptions<true, TRepository>;

import type { ServerWebSocket } from "bun";
import type { AnalysisResult, SelectionAnalysis, VariableDefinition } from "../analyzeQuery/types";
import type { GetSchemaReturn } from "../configuration/getSchemas";
import type { createQueryEventEmitter } from "../utils/event-emitter";

/**
 * Type for the query event emitter instance
 */
export type QueryEventEmitter = ReturnType<typeof createQueryEventEmitter>;

/**
 * Database poller interface - controls polling lifecycle
 */
export interface DatabasePoller {
  start(): Timer | undefined;
  stop(): void;
}

/**
 * Context provided to subscription strategy handlers
 */
export interface SubscriptionContext {
  /** The WebSocket connection */
  ws: ServerWebSocket<unknown>;
  /** Unique subscription ID from the client */
  subscriptionId: string;
  /** Analyzed GraphQL query */
  analysis: AnalysisResult;
  /** The first field being subscribed to */
  field: SelectionAnalysis;
  /** Variable definitions from the query */
  variableDefinitions: VariableDefinition[];
  /** Resolved variable values (after object flattening and $session.* replacement) */
  variables: Record<string, unknown>;
  /** Schema and entity information for the current role */
  schemaEntity: GetSchemaReturn;
  /** Shared event emitter for broadcasting updates */
  eventEmitter: QueryEventEmitter;
}

/**
 * Result of starting a subscription
 */
export interface SubscriptionResult {
  /** Cleanup function called when subscription ends */
  cleanup?: () => void | Promise<void>;
  /** True if subscription was joined to an existing connection (no new poll/consumer needed) */
  alreadyExists?: boolean;
}

/**
 * Strategy interface for handling different subscription sources
 */
export interface SubscriptionStrategy {
  /**
   * Unique identifier for this strategy (matches EntitySource enum value)
   */
  readonly source: string;

  /**
   * Start the subscription and return a cleanup function
   */
  subscribe(context: SubscriptionContext): Promise<SubscriptionResult>;

  /**
   * Generate the unique subscription key for this subscription
   */
  getSubscriptionKey(context: SubscriptionContext): string;
}

/**
 * Registry type for subscription strategies
 */
export type SubscriptionStrategyRegistry = Map<string, SubscriptionStrategy>;

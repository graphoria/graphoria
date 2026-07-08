import type { SubscriptionStrategy, SubscriptionStrategyRegistry } from "../types";
import { EntitySource } from "../../types/resolver";
import { createDatabaseSubscriptionStrategy } from "./database";
import { createQueueSubscriptionStrategy } from "./queue";

/**
 * Create and populate the subscription strategy registry
 */
export const createSubscriptionStrategyRegistry = (): SubscriptionStrategyRegistry => {
  const registry: SubscriptionStrategyRegistry = new Map();

  // Register built-in strategies
  const databaseStrategy = createDatabaseSubscriptionStrategy();
  const queueStrategy = createQueueSubscriptionStrategy();

  registry.set(EntitySource.TABLE, databaseStrategy);
  registry.set(EntitySource.QUEUE_PUBLISHER, queueStrategy);

  return registry;
};

/**
 * Helper to get strategy by source, with fallback to database strategy
 */
export const getStrategyForSource = (
  registry: SubscriptionStrategyRegistry,
  source: string | undefined,
): SubscriptionStrategy | undefined => {
  if (!source) {
    // Default to database strategy for backward compatibility
    return registry.get(EntitySource.TABLE);
  }
  return registry.get(source);
};

// Re-export individual strategies for testing or custom registration
export { createDatabaseSubscriptionStrategy } from "./database";
export { createQueueSubscriptionStrategy } from "./queue";

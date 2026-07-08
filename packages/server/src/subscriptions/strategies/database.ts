import type { SubscriptionContext, SubscriptionResult, SubscriptionStrategy } from "../types";
import { EntitySource } from "../../types/resolver";
import { createDatabasePoller } from "../utils/polling";

/**
 * Database subscription strategy - polls database for changes using hash comparison
 *
 * This strategy:
 * 1. Manages connection registration with the event emitter
 * 2. Creates a poller that executes the query periodically
 * 3. Uses hash comparison to detect data changes
 * 4. Only broadcasts updates when data has actually changed
 */
export const createDatabaseSubscriptionStrategy = (): SubscriptionStrategy => ({
  source: EntitySource.TABLE,

  getSubscriptionKey(context) {
    const { analysis } = context;
    const operation = analysis.operations[0];
    // Use operation name as the base key (existing behavior)
    return operation.name ?? operation.fields[0]?.name ?? "unknown";
  },

  async subscribe(context: SubscriptionContext): Promise<SubscriptionResult> {
    const {
      ws,
      subscriptionId,
      analysis,
      variableDefinitions,
      variables,
      schemaEntity,
      eventEmitter,
    } = context;

    const subscriptionKey = this.getSubscriptionKey(context);

    // Check if connection already exists - join existing subscription
    if (eventEmitter.hasConnection(subscriptionKey)) {
      eventEmitter.sendDataByQueryNameToSingleClient(subscriptionKey, ws, subscriptionId);
      eventEmitter.addConnection(subscriptionKey, subscriptionId, ws);
      return { alreadyExists: true };
    }

    // Register new connection
    eventEmitter.addConnection(subscriptionKey, subscriptionId, ws);

    // Create and start the poller
    const poller = await createDatabasePoller({
      analysis,
      variableDefinitions,
      variables,
      schemaEntity,
      subscriptionKey,
      eventEmitter,
      pollIntervalMs: 1000,
    });

    // Store poll reference for cleanup by event emitter
    eventEmitter.setPoll(subscriptionKey, poller);

    // Start polling
    poller.start();

    return {
      cleanup: () => poller.stop(),
    };
  },
});

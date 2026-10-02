import type { SubscriptionContext, SubscriptionResult, SubscriptionStrategy } from "../types";
import { EntitySource } from "../../types/resolver";
import { filterResultBySelection } from "../../utils/selection";

/**
 * Builds a composite subscription key from the field name, alias, and
 * selections. Clients with the exact same query (including alias and
 * requested fields) share a single connection group; any difference
 * produces a distinct key and therefore its own group with its own
 * responseKey and dataTransform.
 */
const buildCompositeKey = (context: SubscriptionContext): string => {
  const { field } = context;
  return `${field.name}:${field.alias ?? ""}:${JSON.stringify(field.selections)}`;
};

/**
 * Queue subscription strategy - leverages existing queue consumer infrastructure
 *
 * Queue subscriptions are push-based, unlike database subscriptions:
 * - No polling needed - messages are pushed via the queue consumer
 * - The queue consumer (@graphoria/queues) already reaches queryEventEmitter.sendDataUpdate()
 *   through the runtime context's emitSubscriptionEvent
 * - This strategy manages connection registration with the event emitter
 */
export const createQueueSubscriptionStrategy = (): SubscriptionStrategy => ({
  source: EntitySource.QUEUE_SUBSCRIBER,

  getSubscriptionKey(context) {
    return buildCompositeKey(context);
  },

  async subscribe(context: SubscriptionContext): Promise<SubscriptionResult> {
    const { ws, subscriptionId, eventEmitter, field } = context;
    const subscriptionKey = this.getSubscriptionKey(context);
    // The field key is what queue consumers broadcast on (e.g. "conn_queueName")
    const fieldKey = field.name;

    // Join an existing group. A message is an event, not a state: unlike a
    // table subscription, the joining client gets no replay of the last one.
    if (eventEmitter.hasConnection(subscriptionKey)) {
      eventEmitter.addConnection(subscriptionKey, subscriptionId, ws);
      return { alreadyExists: true };
    }

    // Register new connection group
    eventEmitter.addConnection(subscriptionKey, subscriptionId, ws);
    // Tie the composite key to the field key so sendDataUpdate fan-out works
    eventEmitter.registerFieldMapping(fieldKey, subscriptionKey);
    // Top-level response key (handles field alias)
    eventEmitter.setResponseKey(subscriptionKey, field.alias || field.name);
    // Apply selection filtering and nested alias mapping to each message
    eventEmitter.setDataTransform(subscriptionKey, (data) =>
      filterResultBySelection(data, field.selections),
    );

    return {
      // No cleanup needed - queue consumers manage their own lifecycle
      cleanup: undefined,
    };
  },
});

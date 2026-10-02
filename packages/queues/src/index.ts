import type {
  KafkaConfig,
  QueueAdapter,
  QueueAdapterType,
  RabbitMQConfig,
} from "@graphoria/server";

import { startKafkaConnections } from "./kafka";
import { startRabbitMQConnections } from "./rabbitmq";

export { startKafkaConnections, startRabbitMQConnections };
export type { QueueAdapter, QueueAdapterType };

export const registerQueueAdapters = (
  setAdapter: (type: QueueAdapterType, adapter: QueueAdapter) => void,
) => {
  setAdapter("rabbitmq", {
    start: async (queues, context) => {
      const manager = await startRabbitMQConnections(queues as RabbitMQConfig[], context);
      return {
        publisherMap: manager.publisherMap,
        sendMessage: manager.sendMessage,
        connections: () =>
          manager.managers.map((m, index) => ({
            type: "rabbitmq" as const,
            name: queues[index]!.name,
            connected: m.isConnected(),
          })),
        cleanup: manager.cleanup,
      };
    },
  });

  setAdapter("kafka", {
    start: async (queues, context) => {
      const manager = await startKafkaConnections(queues as KafkaConfig[], context);
      return {
        publisherMap: manager.publisherMap,
        sendMessage: manager.sendMessage,
        connections: () =>
          manager.managers.map((m, index) => ({
            type: "kafka" as const,
            name: queues[index]!.name,
            connected: m.isConnected(),
          })),
        cleanup: manager.cleanup,
      };
    },
  });
};

import type { KafkaPublisher } from "../queues/kafka";
import type { RabbitMQPublisher } from "../queues/rabbitmq";
import type { QueueConfig } from "../types/zod/queue";

import { startKafkaConnections } from "../queues/kafka";
import { startRabbitMQConnections } from "../queues/rabbitmq";
import { logger } from "../logging";

export type QueueConnectionStatus = {
  type: "rabbitmq" | "kafka";
  name: string;
  connected: boolean;
};

export type QueueManager = {
  publisherMap: () => Record<string, RabbitMQPublisher | KafkaPublisher>;
  sendMessage: (
    publisherName: string,
    message: string | object,
    key?: string,
  ) => Promise<boolean> | boolean;
  connections: () => QueueConnectionStatus[];
  cleanup?: () => Promise<void>;
};

export let queueManager: QueueManager | undefined;

export const setQueueManager = (manager: QueueManager | undefined) => {
  queueManager = manager;
};

export const instantiateQueues = async (queues: QueueConfig[]) => {
  // Separate RabbitMQ and Kafka queues
  const rabbitMQQueues = queues.filter((queue) => queue.type === "rabbitmq");
  const kafkaQueues = queues.filter((queue) => queue.type === "kafka");

  const managers: QueueManager[] = [];

  // Initialize RabbitMQ connections
  if (rabbitMQQueues.length > 0) {
    const rabbitMQManager = await startRabbitMQConnections(rabbitMQQueues);

    managers.push({
      publisherMap: rabbitMQManager.publisherMap,
      sendMessage: rabbitMQManager.sendMessage,
      connections: () =>
        rabbitMQManager.managers.map((manager, index) => ({
          type: "rabbitmq" as const,
          name: rabbitMQQueues[index]!.name,
          connected: manager.isConnected(),
        })),
    });
  }

  // Initialize Kafka connections
  if (kafkaQueues.length > 0) {
    const kafkaManager = await startKafkaConnections(kafkaQueues);

    managers.push({
      publisherMap: kafkaManager.publisherMap,
      sendMessage: kafkaManager.sendMessage,
      connections: () =>
        kafkaManager.managers.map((manager, index) => ({
          type: "kafka" as const,
          name: kafkaQueues[index]!.name,
          connected: manager.isConnected(),
        })),
      cleanup: kafkaManager.cleanup,
    });
  }

  // Merge all publisher maps and create unified send function
  const combinedPublisherMap = () =>
    managers.reduce((acc, manager) => ({ ...acc, ...manager.publisherMap() }), {});

  const combinedSendMessage = async (
    publisherName: string,
    message: string | object,
    key?: string,
  ) => {
    // Find which manager has this publisher
    for (const manager of managers) {
      if (manager.publisherMap()[publisherName]) {
        return await manager.sendMessage(publisherName, message, key);
      }
    }

    logger("queues").error(
      { publisher: publisherName },
      "publisher not found in any queue manager",
    );
    return false;
  };

  const combinedCleanup = async () => {
    await Promise.all(
      managers.filter((manager) => manager.cleanup).map((manager) => manager.cleanup!()),
    );
  };

  queueManager = {
    publisherMap: combinedPublisherMap,
    sendMessage: combinedSendMessage,
    connections: () => managers.flatMap((manager) => manager.connections()),
    cleanup: combinedCleanup,
  };
};

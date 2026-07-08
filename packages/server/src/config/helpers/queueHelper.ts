import type { KafkaConfigInput, RabbitMQConfigInput } from "../../types/zod/queue";

/**
 * Builder for a queue (RabbitMQ or Kafka) configuration. Adds the `type`
 * discriminator so the rest of the config object can be written without it.
 *
 * @example
 * ```ts
 * import { queue } from "@graphoria/server/config";
 *
 * queues: [
 *   queue.rabbitmq({ name: "events", connection: "amqp://localhost" }),
 *   queue.kafka({ name: "events", connection: { brokers: ["localhost:9092"] } }),
 * ];
 * ```
 */
export const queue = {
  rabbitmq: (config: Omit<RabbitMQConfigInput, "type">): RabbitMQConfigInput => ({
    ...config,
    type: "rabbitmq",
  }),

  kafka: (config: Omit<KafkaConfigInput, "type">): KafkaConfigInput => ({
    ...config,
    type: "kafka",
  }),
};

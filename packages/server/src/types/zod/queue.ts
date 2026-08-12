import { z } from "zod";

import {
  BaseQueueConfigZod,
  KafkaConnectionZod,
  PublisherConfigZod,
  RabbitMQConnectionZod,
  ReconnectConfigZod,
  SubscriberConfigZod,
  TopicConfigZod,
} from "../../config";
import type { CacheContext, SubscriberHandler } from "../../config";

// Re-export base types and schemas from the config module
export type {
  ReconnectConfig,
  PublisherConfig,
  SubscriberConfig,
  TopicConfig,
  CacheContext,
  SubscriberHandler,
  RabbitMQConnection,
  KafkaConnection,
} from "../../config";

export {
  ReconnectConfigZod,
  PublisherConfigZod,
  SubscriberConfigZod,
  TopicConfigZod,
  BaseQueueConfigZod,
  RabbitMQConnectionZod,
  KafkaConnectionZod,
} from "../../config";

// ============================================================================
// RabbitMQ Configuration (extends base)
// ============================================================================

const RabbitMQConfigZod = BaseQueueConfigZod.extend({
  type: z.literal("rabbitmq"),
  /** Connection config or AMQP URL string */
  connection: z.union([z.url(), RabbitMQConnectionZod]),
});

// ============================================================================
// Kafka Configuration (extends base)
// ============================================================================

const KafkaConfigZod = BaseQueueConfigZod.extend({
  type: z.literal("kafka"),
  /** Connection config or broker string "host:port" */
  connection: z.union([z.string(), KafkaConnectionZod]),
});

// ============================================================================
// Union Type with Transform for Backward Compatibility
// ============================================================================

/**
 * Transforms user-facing flat config (publishers/subscribers/topics) into
 * the internal runtime shape with derived exchanges[] and queues[] arrays.
 */
const transformQueueConfig = <T extends z.infer<typeof BaseQueueConfigZod>>(
  config: T,
): T & {
  exchanges: Array<{
    name: string;
    type: "topic" | "direct" | "fanout" | "headers";
    options?: { durable?: boolean; autoDelete?: boolean };
    publishers: Array<{
      name: string;
      resolverName: string;
      routingKey: string;
      options?: { persistent?: boolean; headers?: Record<string, string> };
    }>;
  }>;
  queues: Array<{
    name: string;
    queue?: string;
    groupId?: string;
    bindings: Array<{ exchange: string; pattern: string }>;
    queueOptions?: { durable?: boolean; autoDelete?: boolean };
    handler?: SubscriberHandler;
  }>;
} => {
  // Group publishers by topic to create exchanges
  const topicPublishers = new Map<
    string,
    Array<{ key: string; config: (typeof config.publishers)[string] }>
  >();

  Object.entries(config.publishers).forEach(([key, pub]) => {
    const existing = topicPublishers.get(pub.topic) || [];
    existing.push({ key, config: pub });
    topicPublishers.set(pub.topic, existing);
  });

  // Create exchanges from topics
  const exchanges = Array.from(topicPublishers.entries()).map(([topic, pubs]) => {
    const topicConfig = config.topics[topic];
    return {
      name: topic,
      type: topicConfig?.type || ("topic" as const),
      options: topicConfig
        ? { durable: topicConfig.durable, autoDelete: topicConfig.autoDelete }
        : undefined,
      publishers: pubs.map((p) => ({
        name: p.key,
        resolverName: `${config.name}_${p.key}`,
        routingKey: p.config.routingKey || "",
        options: {
          persistent: p.config.persistent,
          headers: p.config.headers,
        },
      })),
    };
  });

  // Create queues from subscribers
  const queues = Object.entries(config.subscribers).map(([key, sub]) => ({
    name: key,
    queue: sub.queue,
    groupId: sub.group,
    bindings: [{ exchange: sub.topic, pattern: sub.pattern }],
    queueOptions: {
      durable: sub.durable,
      autoDelete: sub.autoDelete,
    },
    handler: sub.handler,
  }));

  return {
    ...config,
    exchanges,
    queues,
  };
};

const RabbitMQConfigTransformed = RabbitMQConfigZod.transform(transformQueueConfig);
const KafkaConfigTransformed = KafkaConfigZod.transform(transformQueueConfig);

export const QueueConfigZod = z.discriminatedUnion("type", [
  RabbitMQConfigTransformed,
  KafkaConfigTransformed,
]);

export type QueueConfig = z.infer<typeof QueueConfigZod>;
export type RabbitMQConfig = z.infer<typeof RabbitMQConfigTransformed>;
export type KafkaConfig = z.infer<typeof KafkaConfigTransformed>;

/** Pre-transform input types — the shape users write in graphoria.ts */
export type RabbitMQConfigInput = z.input<typeof RabbitMQConfigTransformed>;
export type KafkaConfigInput = z.input<typeof KafkaConfigTransformed>;

// ============================================================================
// Transform helpers — Convert simplified config to internal format
// ============================================================================

/**
 * Derives unique topics from publishers and subscribers
 */
export const deriveTopics = (config: QueueConfig): string[] => {
  const topics = new Set<string>();

  Object.values(config.publishers).forEach((pub) => topics.add(pub.topic));
  Object.values(config.subscribers).forEach((sub) => topics.add(sub.topic));

  return Array.from(topics);
};

/**
 * Get publisher resolver name
 */
export const getPublisherResolverName = (queueName: string, publisherKey: string): string =>
  `${queueName}_${publisherKey}`;

/**
 * Get subscriber resolver name
 */
export const getSubscriberResolverName = (queueName: string, subscriberKey: string): string =>
  `${queueName}_${subscriberKey}`;

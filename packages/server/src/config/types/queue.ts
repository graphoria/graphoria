import { z } from "zod";

// ============================================================================
// Base Zod Schemas for Queue Configuration
// ============================================================================
// These are the pre-transform base schemas — the single source of truth for
// queue config authoring types. Server-only extensions and the publishers/
// subscribers/topics → exchanges/queues pivot transform live in types/zod/queue.ts.

/**
 * Reconnection configuration
 */
export const ReconnectConfigZod = z.object({
  /** Initial delay before first reconnect attempt (ms) */
  initialDelay: z.number().int().positive().default(1000),
  /** Maximum delay between reconnect attempts (ms) */
  maxDelay: z.number().int().positive().default(30000),
  /** Multiplier for exponential backoff */
  multiplier: z.number().positive().default(2),
  /** Maximum number of reconnect attempts (0 = infinite) */
  maxAttempts: z.number().int().nonnegative().default(0),
});

export type ReconnectConfig = z.input<typeof ReconnectConfigZod>;

/**
 * Publisher configuration — defines how to send messages
 */
export const PublisherConfigZod = z.object({
  /** Topic/Exchange name to publish to */
  topic: z.string(),
  /** Routing key (RabbitMQ) or message key (Kafka) */
  routingKey: z.string().optional(),
  /** Whether messages should survive broker restart (RabbitMQ only) */
  persistent: z.boolean().optional().default(true),
  /** Custom headers (Kafka only) */
  headers: z.record(z.string(), z.string()).optional(),
});

export type PublisherConfig = z.input<typeof PublisherConfigZod>;

/**
 * Cache invalidation context passed to subscriber handlers
 */
export type CacheContext = {
  invalidate: (operationName: string, pattern?: Record<string, unknown>) => Promise<boolean>;
};

/**
 * Subscriber handler function — single canonical spelling used by both
 * SubscriberConfigZod and the transformQueueConfig return type.
 */
export type SubscriberHandler = (
  message: unknown,
  context: { cache: CacheContext },
) => Promise<void> | void;

/**
 * Subscriber configuration — defines how to receive messages
 */
export const SubscriberConfigZod = z.object({
  /** Topic/Exchange name to subscribe to */
  topic: z.string(),
  /** Pattern for filtering messages (routing key pattern for RabbitMQ) */
  pattern: z.string().optional().default("#"),
  /** Explicit queue name (RabbitMQ) — auto-generated if not provided */
  queue: z.string().optional(),
  /** Consumer group ID (Kafka) — auto-generated if not provided */
  group: z.string().optional(),
  /** Whether queue should survive broker restart (RabbitMQ only) */
  durable: z.boolean().optional(),
  /** Whether queue should auto-delete when no consumers (RabbitMQ only) */
  autoDelete: z.boolean().optional(),
  /** Handler function to process received messages */
  handler: z.custom<SubscriberHandler>().optional(),
});

export type SubscriberConfig = z.input<typeof SubscriberConfigZod>;

/**
 * Topic/Exchange configuration — for auto-setup
 */
export const TopicConfigZod = z.object({
  /** Exchange type (RabbitMQ only) */
  type: z.enum(["direct", "fanout", "topic", "headers"]).optional().default("topic"),
  /** Whether exchange should survive broker restart */
  durable: z.boolean().optional().default(true),
  /** Whether exchange should auto-delete when no bindings */
  autoDelete: z.boolean().optional().default(false),
});

export type TopicConfig = z.input<typeof TopicConfigZod>;

/**
 * Base queue configuration shared by all providers
 */
export const BaseQueueConfigZod = z.object({
  /** Unique name for this queue connection */
  name: z.string(),
  /** Whether to auto-create topics/exchanges/queues */
  autoSetup: z.boolean().optional().default(true),
  /** Whether this queue is enabled */
  enabled: z.boolean().optional().default(true),
  /** Reconnection configuration */
  reconnect: ReconnectConfigZod.optional(),
  /** Publishers keyed by resolver name — become GraphQL mutations */
  publishers: z.record(z.string(), PublisherConfigZod).optional().default({}),
  /** Subscribers keyed by subscription name — become GraphQL subscriptions */
  subscribers: z.record(z.string(), SubscriberConfigZod).optional().default({}),
  /** Topic configurations for customizing auto-setup behavior */
  topics: z.record(z.string(), TopicConfigZod).optional().default({}),
});

// ============================================================================
// Connection Schemas
// ============================================================================

/**
 * RabbitMQ connection configuration (object form)
 */
export const RabbitMQConnectionZod = z.object({
  hostname: z.string().default("localhost"),
  port: z.number().default(5672),
  username: z.string().optional(),
  password: z.string().optional(),
  vhost: z.string().default("/"),
});

export type RabbitMQConnection = z.input<typeof RabbitMQConnectionZod>;

/**
 * Kafka connection configuration
 */
export const KafkaConnectionZod = z.object({
  /** Broker addresses — "host:port" or ["host1:port1", "host2:port2"] */
  brokers: z.union([z.string(), z.array(z.string())]),
  /** Client identifier sent to the broker (default: "datagraph-<queue name>") */
  clientId: z.string().optional(),
  /** Enable SSL/TLS */
  ssl: z.boolean().optional().default(false),
  /** SASL authentication (optional) */
  sasl: z
    .object({
      mechanism: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).optional().default("plain"),
      username: z.string(),
      password: z.string(),
    })
    .optional(),
});

export type KafkaConnection = z.input<typeof KafkaConnectionZod>;

// ============================================================================
// Pre-transform Queue Config Union (used by ConfigurationInput)
// ============================================================================
// These mirror the .extend() logic in types/zod/queue.ts — the shape users
// write in graphoria.ts before transformQueueConfig derives exchanges/queues.

/** RabbitMQ queue config as authored by the user (pre-transform) */
export type RabbitMQQueueConfig = z.input<typeof BaseQueueConfigZod> & {
  type: "rabbitmq";
  connection: string | RabbitMQConnection;
};

/** Kafka queue config as authored by the user (pre-transform) */
export type KafkaQueueConfig = z.input<typeof BaseQueueConfigZod> & {
  type: "kafka";
  connection: string | KafkaConnection;
};

/** Queue configuration union — the shape users write in graphoria.ts */
export type QueueConfig = RabbitMQQueueConfig | KafkaQueueConfig;

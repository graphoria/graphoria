import { Kafka } from "kafkajs";
import { nanoid } from "nanoid";

import type { Consumer, EachMessagePayload, Producer, SASLOptions } from "kafkajs";
import type { KafkaConfig } from "../types/zod/queue";

import { queryEventEmitter } from "../configuration/gql/handleGraphQLSubscriptionFactory";
import { logger } from "../logging";

// ============================================================================
// Reconnection Configuration
// ============================================================================

const RECONNECT_INITIAL_DELAY = 1000; // 1 second
const RECONNECT_MAX_DELAY = 30000; // 30 seconds
const RECONNECT_MULTIPLIER = 2;
const CONNECTION_TIMEOUT = 10000; // 10 seconds timeout for initial connection

/**
 * Creates a promise that rejects after a timeout
 */
const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> => {
  let timeoutId: Timer;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
};

const sendMessage = (connectionName: string, name: string, payload: EachMessagePayload) => {
  queryEventEmitter.sendDataUpdate(`${connectionName}_${name}`, {
    data: {
      message: payload.message.value?.toString() || "",
      id: `${payload.partition}-${payload.message.offset}`,
    },
  });
};

export const startConsumer = async (
  connectionName: string,
  name: string,
  topic: string,
  consumer: Consumer,
  _consumerGroup: string,
) => {
  const log = logger("kafka").child({ queue: connectionName, consumer: name });

  await consumer.subscribe({ topic });

  await consumer.run({
    eachMessage: async (payload) => {
      try {
        sendMessage(connectionName, name, payload);
      } catch (error) {
        log.error({ err: error }, "message processing failed");
        // Note: Kafka doesn't have individual message nack like RabbitMQ
        // Error handling would be done through retry mechanisms or dead letter topics
      }
    },
  });
};

export type KafkaPublisher = {
  name: string;
  topic: string;
  send: (message: string | object, key?: string) => Promise<boolean>;
};

// ============================================================================
// Kafka Connection Manager with Reconnection
// ============================================================================

type KafkaConnectionState = {
  kafka: Kafka | null;
  producer: Producer | null;
  consumers: Consumer[];
  isConnecting: boolean;
  publishers: Record<string, KafkaPublisher>;
};

export type KafkaConnectionManager = {
  connect: () => Promise<void>;
  getPublishers: () => Record<string, KafkaPublisher>;
  isConnected: () => boolean;
  cleanup: () => Promise<void>;
  onPublishersChanged: (callback: () => void) => void;
};

// Suppress KafkaJS timeout warning (known bug with Bun)
process.on("warning", (warning) => {
  if (warning.name === "TimeoutNegativeWarning") {
    return;
  }
  const log = logger("kafka");
  log.warn(
    { warningName: warning.name, warningMessage: warning.message },
    "unhandled process warning",
  );
});

const createKafkaConnectionManager = (queueConfig: KafkaConfig): KafkaConnectionManager => {
  if (queueConfig.type !== "kafka") {
    throw new Error("Invalid queue type for Kafka connection manager");
  }

  const log = logger("kafka").child({ queue: queueConfig.name });

  const state: KafkaConnectionState = {
    kafka: null,
    producer: null,
    consumers: [],
    isConnecting: false,
    publishers: {},
  };

  // Callback to notify when publishers change (connect/reconnect)
  let publishersChangedCallback: (() => void) | null = null;

  let reconnectAttempts = 0;
  let shouldReconnect = true;

  // Parse connection config
  const getConnectionConfig = () => {
    const conn = queueConfig.connection;
    if (typeof conn === "string") {
      // Parse broker string: "host:port" or "host1:port1,host2:port2"
      return {
        brokers: conn.split(",").map((b) => b.trim()),
        clientId: undefined as string | undefined,
        ssl: false,
        sasl: undefined,
      };
    }
    return {
      brokers: Array.isArray(conn.brokers) ? conn.brokers : [conn.brokers],
      clientId: conn.clientId,
      ssl: conn.ssl,
      sasl: conn.sasl,
    };
  };

  const setupConnection = async (): Promise<void> => {
    if (state.isConnecting || !shouldReconnect) return;
    state.isConnecting = true;

    try {
      log.info("connecting");

      const connConfig = getConnectionConfig();

      // Create Kafka client with built-in retry
      const kafka = new Kafka({
        clientId: connConfig.clientId ?? `datagraph-${queueConfig.name}`,
        brokers: connConfig.brokers,
        ssl: connConfig.ssl,
        // kafkajs discriminates SASLOptions on the mechanism literal; the config
        // union carries all three mechanisms with the same credential shape
        sasl: connConfig.sasl
          ? ({
              mechanism: connConfig.sasl.mechanism,
              username: connConfig.sasl.username,
              password: connConfig.sasl.password,
            } as SASLOptions)
          : undefined,
        logLevel: 0,
        retry: {
          initialRetryTime: RECONNECT_INITIAL_DELAY,
          retries: 10,
          maxRetryTime: RECONNECT_MAX_DELAY,
          factor: RECONNECT_MULTIPLIER,
        },
      });

      // Create and connect producer
      const producer = kafka.producer({
        retry: {
          initialRetryTime: RECONNECT_INITIAL_DELAY,
          retries: 10,
          maxRetryTime: RECONNECT_MAX_DELAY,
        },
      });

      producer.on("producer.disconnect", () => {
        log.warn("producer disconnected, reconnecting");
        state.producer = null;
        scheduleReconnect();
      });

      // Connect producer with timeout to prevent hanging
      await producer.connect();

      // Create publishers for each topic
      for (const exchange of queueConfig.exchanges) {
        for (const p of exchange.publishers) {
          state.publishers[`${queueConfig.name}_${p.name}`] = {
            name: p.name,
            topic: exchange.name,
            send: async (message: string | object, key?: string) => {
              if (!state.producer) {
                log.error("cannot send: producer not available");
                return false;
              }
              try {
                await state.producer.send({
                  topic: exchange.name,
                  messages: [
                    {
                      key: key || p.routingKey,
                      value: typeof message === "string" ? message : JSON.stringify(message),
                      headers: p.options?.headers,
                    },
                  ],
                });
                return true;
              } catch (error) {
                log.error({ err: error, topic: exchange.name }, "failed to send message");
                return false;
              }
            },
          };
        }
      }

      // Create consumers
      const consumers: Consumer[] = [];
      for (const route of queueConfig.queues) {
        const consumerGroup = route.groupId || `${route.name}-group-${nanoid(10)}`;

        const consumer = kafka.consumer({
          groupId: consumerGroup,
          sessionTimeout: 30000,
          heartbeatInterval: 3000,
          retry: {
            initialRetryTime: RECONNECT_INITIAL_DELAY,
            retries: 10,
            maxRetryTime: RECONNECT_MAX_DELAY,
          },
        });

        consumer.on("consumer.disconnect", () => {
          log.warn({ consumer: route.name }, "consumer disconnected");
        });

        consumer.on("consumer.crash", async (event) => {
          log.error({ consumer: route.name, err: event.payload.error }, "consumer crashed");
          if (event.payload.restart) {
            log.info({ consumer: route.name }, "consumer will restart automatically");
          }
        });

        // Connect consumer with timeout to prevent hanging
        await withTimeout(
          consumer.connect(),
          CONNECTION_TIMEOUT,
          `[Kafka] Consumer connection timeout for ${route.name}`,
        );

        for (const binding of route.bindings) {
          await startConsumer(
            queueConfig.name,
            route.name,
            binding.exchange,
            consumer,
            consumerGroup,
          );
        }

        consumers.push(consumer);
      }

      state.kafka = kafka;
      state.producer = producer;
      state.consumers = consumers;
      reconnectAttempts = 0;

      // Notify that publishers have changed
      if (publishersChangedCallback) {
        publishersChangedCallback();
      }

      log.info("connected");
    } catch (error) {
      log.error({ err: error }, "connection failed");
      scheduleReconnect();
    } finally {
      state.isConnecting = false;
    }
  };

  const scheduleReconnect = () => {
    if (!shouldReconnect) return;

    const delay = Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempts),
      RECONNECT_MAX_DELAY,
    );
    reconnectAttempts++;

    log.info({ delay, attempt: reconnectAttempts }, "scheduling reconnect");

    setTimeout(() => {
      setupConnection();
    }, delay);
  };

  const cleanup = async () => {
    shouldReconnect = false;
    try {
      if (state.producer) {
        await state.producer.disconnect();
      }
      await Promise.all(state.consumers.map((c) => c.disconnect()));
    } catch (error) {
      log.error({ err: error }, "error during cleanup");
    }
  };

  return {
    connect: setupConnection,
    getPublishers: () => state.publishers,
    isConnected: () => state.producer !== null,
    cleanup,
    onPublishersChanged: (callback: () => void) => {
      publishersChangedCallback = callback;
    },
  };
};

// ============================================================================
// Main Entry Point
// ============================================================================

export const startKafkaConnections = async (queues: KafkaConfig[]) => {
  const log = logger("kafka");
  const managers = queues.map((queue) => createKafkaConnectionManager(queue));

  // Cached publisher map with dirty flag for optimization
  let cachedPublisherMap: Record<string, KafkaPublisher> = {};
  let isPublisherMapDirty = true;

  const markDirty = () => {
    isPublisherMapDirty = true;
  };

  // Register change callbacks for each manager
  for (const manager of managers) {
    manager.onPublishersChanged(markDirty);
  }

  // Start connection attempts for all queues (non-blocking)
  // This allows the app to start even if Kafka isn't immediately available
  // Failed connections will automatically retry in the background
  for (const manager of managers) {
    manager.connect().catch((error) => {
      log.warn({ err: error }, "initial connection failed, will retry");
    });
  }

  // Get publisher map - rebuilds only when dirty
  const getPublisherMap = () => {
    if (isPublisherMapDirty) {
      cachedPublisherMap = managers.reduce<Record<string, KafkaPublisher>>(
        (acc, manager) => ({ ...acc, ...manager.getPublishers() }),
        {},
      );
      isPublisherMapDirty = false;
    }
    return cachedPublisherMap;
  };

  const sendMessage = async (publisherName: string, message: string | object, key?: string) => {
    const publisherMap = getPublisherMap();
    const publisher = publisherMap[publisherName];

    if (!publisher) {
      log.error({ publisher: publisherName }, "publisher not found");
      return false;
    }

    const result = await publisher.send(message, key);

    if (!result) {
      log.error({ publisher: publisherName }, "failed to publish message");
      return false;
    }

    return true;
  };

  const cleanup = async () => {
    await Promise.all(managers.map((manager) => manager.cleanup()));
  };

  return {
    managers,
    publisherMap: getPublisherMap,
    sendMessage,
    cleanup,
  };
};

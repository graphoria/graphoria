import { connect } from "amqplib";
import { nanoid } from "nanoid";

import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import type { RabbitMQConfig } from "../types/zod/queue";

import { queryEventEmitter } from "../configuration/gql/handleGraphQLSubscriptionFactory";
import { InvalidationHelper } from "../singletons/cache/registry";
import { logger } from "../logging";

// ============================================================================
// Reconnection Configuration
// ============================================================================

const RECONNECT_INITIAL_DELAY = 1000; // 1 second
const RECONNECT_MAX_DELAY = 30000; // 30 seconds
const RECONNECT_MULTIPLIER = 2;

const sendMessage = (connectionName: string, name: string, msg: ConsumeMessage) => {
  queryEventEmitter.sendDataUpdate(`${connectionName}_${name}`, {
    data: {
      message: msg.content.toString(),
      id: msg.fields.deliveryTag,
    },
  });
};

export const startConsumer = async (
  connectionName: string,
  name: string,
  queueName: string,
  channel: Channel,
  handler?: (
    message: unknown,
    context: {
      cache: {
        invalidate: (operationName: string, pattern?: Record<string, unknown>) => Promise<boolean>;
      };
    },
  ) => Promise<void> | void,
) => {
  const log = logger("rabbitmq").child({ queue: connectionName, consumer: name });

  channel.consume(queueName, async (msg) => {
    if (msg !== null) {
      try {
        sendMessage(connectionName, name, msg);

        if (handler) {
          let parsedMessage = msg.content.toString();
          try {
            parsedMessage = JSON.parse(parsedMessage);
          } catch {
            // message is not JSON, proceed with raw string
          }

          await handler(parsedMessage, { cache: InvalidationHelper });
        }

        channel.ack(msg);
      } catch (error) {
        log.error({ err: error }, "message processing failed");

        channel.nack(msg);
      }
    }
  });
};

export type RabbitMQPublisher = {
  name: string;
  routingKey: string;
  exchangeName: string;
  send: (message: string | object) => boolean;
};

export type RabbitMQQueue = RabbitMQConfig;

// ============================================================================
// RabbitMQ Connection Manager with Reconnection
// ============================================================================

type RabbitMQConnectionState = {
  connection: ChannelModel | null;
  channel: Channel | null;
  isConnecting: boolean;
  publishers: Record<string, RabbitMQPublisher>;
};

export type RabbitMQConnectionManager = {
  connect: () => Promise<void>;
  getPublishers: () => Record<string, RabbitMQPublisher>;
  isConnected: () => boolean;
  cleanup: () => Promise<void>;
  onPublishersChanged: (callback: () => void) => void;
};

export type RabbitMQConnectionManagerOptions = {
  connect?: typeof connect;
  setTimeout?: typeof setTimeout;
};

export const createRabbitMQConnectionManager = (
  queueConfig: RabbitMQQueue,
  options: RabbitMQConnectionManagerOptions = {},
): RabbitMQConnectionManager => {
  const log = logger("rabbitmq").child({ queue: queueConfig.name });
  const connectFn = options.connect ?? connect;
  const setTimeoutFn = options.setTimeout ?? setTimeout;
  const state: RabbitMQConnectionState = {
    connection: null,
    channel: null,
    isConnecting: false,
    publishers: {},
  };

  // Callback to notify when publishers change (connect/reconnect)
  let publishersChangedCallback: (() => void) | null = null;

  let reconnectAttempts = 0;

  const setupConnection = async (): Promise<void> => {
    if (state.isConnecting) return;
    state.isConnecting = true;

    try {
      log.info("connecting");

      const rmqConnection = await connectFn(queueConfig.connection);
      const channel = await rmqConnection.createChannel();

      // Set up error handlers for reconnection
      rmqConnection.on("error", (err) => {
        log.error({ err }, "connection error");
      });

      rmqConnection.on("close", () => {
        log.warn("connection closed, reconnecting");
        state.connection = null;
        state.channel = null;
        scheduleReconnect();
      });

      channel.on("error", (err) => {
        log.error({ err }, "channel error");
      });

      channel.on("close", () => {
        log.warn("channel closed");
        state.channel = null;
      });

      // Set up exchanges and publishers
      for (const exchange of queueConfig.exchanges) {
        if (queueConfig.autoSetup) {
          await channel.assertExchange(exchange.name, exchange.type, exchange.options);
        }

        for (const p of exchange.publishers) {
          state.publishers[`${queueConfig.name}_${p.name}`] = {
            name: p.name,
            routingKey: p.routingKey,
            exchangeName: exchange.name,
            send: (message: string | object) => {
              if (!state.channel) {
                log.error("cannot send: channel not available");
                return false;
              }
              return state.channel.publish(
                exchange.name,
                p.routingKey,
                Buffer.from(typeof message === "string" ? message : JSON.stringify(message)),
                p.options,
              );
            },
          };
        }
      }

      // Set up queues and consumers
      for (const route of queueConfig.queues) {
        const queueName = route.queue ?? `${route.name}-${nanoid(10)}`;

        const durable = route.queueOptions?.durable ?? !!route.queue;
        const autoDelete = route.queueOptions?.autoDelete ?? !route.queue;

        if (!route.queue || (route.queue && queueConfig.autoSetup)) {
          await channel.assertQueue(queueName, {
            ...route.queueOptions,
            durable,
            autoDelete,
          });

          for (const binding of route.bindings) {
            await channel.bindQueue(queueName, binding.exchange, binding.pattern);
          }
        }

        await startConsumer(queueConfig.name, route.name, queueName, channel, route.handler);
      }

      state.connection = rmqConnection;
      state.channel = channel;
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
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempts),
      RECONNECT_MAX_DELAY,
    );
    reconnectAttempts++;

    log.info({ delay, attempt: reconnectAttempts }, "scheduling reconnect");

    setTimeoutFn(() => {
      void setupConnection().catch((error) => {
        log.error({ err: error }, "reconnect attempt failed");
      });
    }, delay);
  };

  const cleanup = async () => {
    try {
      if (state.channel) {
        await state.channel.close();
      }
      if (state.connection) {
        await state.connection.close();
      }
    } catch (error) {
      log.error({ err: error }, "error during cleanup");
    }
  };

  return {
    connect: setupConnection,
    getPublishers: () => state.publishers,
    isConnected: () => state.connection !== null && state.channel !== null,
    cleanup,
    onPublishersChanged: (callback: () => void) => {
      publishersChangedCallback = callback;
    },
  };
};

// ============================================================================
// Main Entry Point
// ============================================================================

export const startRabbitMQConnections = async (queues: RabbitMQQueue[]) => {
  const log = logger("rabbitmq");
  const managers = queues.map((queue) => createRabbitMQConnectionManager(queue));

  // Cached publisher map with dirty flag for optimization
  let cachedPublisherMap: Record<string, RabbitMQPublisher> = {};
  let isPublisherMapDirty = true;

  const markDirty = () => {
    isPublisherMapDirty = true;
  };

  // Register change callbacks for each manager
  for (const manager of managers) {
    manager.onPublishersChanged(markDirty);
  }

  // Start connection attempts for all queues (non-blocking)
  // This allows the app to start even if RabbitMQ isn't immediately available
  // Failed connections will automatically retry in the background
  for (const manager of managers) {
    manager.connect().catch((error) => {
      log.warn({ err: error }, "initial connection failed, will retry");
    });
  }

  // Get publisher map - rebuilds only when dirty
  const getPublisherMap = () => {
    if (isPublisherMapDirty) {
      cachedPublisherMap = managers.reduce<Record<string, RabbitMQPublisher>>(
        (acc, manager) => ({ ...acc, ...manager.getPublishers() }),
        {},
      );
      isPublisherMapDirty = false;
    }
    return cachedPublisherMap;
  };

  const sendMessage = (publisherName: string, message: string | object, _key?: string) => {
    const publisherMap = getPublisherMap();
    const publisher = publisherMap[publisherName];

    if (!publisher) {
      log.error({ publisher: publisherName }, "publisher not found");
      return false;
    }

    const result = publisher.send(message);

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

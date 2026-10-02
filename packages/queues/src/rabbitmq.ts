import { connect } from "amqplib";
import { nanoid } from "nanoid";

import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from "amqplib";
import type { QueueRuntimeContext, RabbitMQConfig } from "@graphoria/server";

// ============================================================================
// Reconnection Configuration
// ============================================================================

// Without a `reconnect` option: 1 s, doubling up to 30 s, forever.
const DEFAULT_RECONNECT = { initialDelay: 1000, maxDelay: 30000, multiplier: 2, maxAttempts: 0 };
// A broker in a memory or disk alarm confirms a publish only once the alarm clears.
const CONFIRM_TIMEOUT = 10000;

const sendMessage = (
  context: QueueRuntimeContext,
  connectionName: string,
  name: string,
  msg: ConsumeMessage,
) => {
  context.emitSubscriptionEvent(`${connectionName}_${name}`, {
    data: {
      message: msg.content.toString(),
      id: String(msg.fields.deliveryTag),
    },
  });
};

export const startConsumer = async (
  context: QueueRuntimeContext,
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
  const log = context.logger("rabbitmq").child({ queue: connectionName, consumer: name });

  const record = (outcome: "success" | "error") =>
    context.incMetric("graphoria_queue_messages_consumed_total", {
      broker: "rabbitmq",
      queue: connectionName,
      consumer: name,
      outcome,
    });

  await channel.consume(queueName, async (msg) => {
    // The broker cancelled the consumer (its queue was deleted). Closing the
    // channel gets the queue reconnected, which declares and consumes it again.
    if (msg === null) {
      log.warn("consumer cancelled by the broker");
      await channel.close().catch((err) => log.warn({ err }, "error closing the channel"));
      return;
    }

    let outcome: "success" | "error" = "success";
    try {
      sendMessage(context, connectionName, name, msg);

      if (handler) {
        let parsedMessage = msg.content.toString();
        try {
          parsedMessage = JSON.parse(parsedMessage);
        } catch {
          // message is not JSON, proceed with raw string
        }

        await handler(parsedMessage, { cache: context.cache });
      }
    } catch (error) {
      log.error({ err: error }, "message processing failed");
      outcome = "error";
    }

    // The channel may have closed while the handler ran: amqplib then throws
    // from ack / nack, and the broker redelivers the message itself. A failed
    // message goes back on the queue once; failing again, it is dropped, or
    // dead-lettered where a policy sets an exchange for it.
    try {
      if (outcome === "success") channel.ack(msg);
      else channel.nack(msg, false, !msg.fields.redelivered);
    } catch (error) {
      log.warn({ err: error }, "message not settled: channel closed");
    }
    record(outcome);
  });
};

export type RabbitMQPublisher = {
  name: string;
  routingKey: string;
  exchangeName: string;
  send: (message: string | object) => Promise<boolean>;
};

export type RabbitMQQueue = RabbitMQConfig;

// ============================================================================
// RabbitMQ Connection Manager with Reconnection
// ============================================================================

type RabbitMQConnectionState = {
  connection: ChannelModel | null;
  channel: ConfirmChannel | null;
  isConnecting: boolean;
};

export type RabbitMQConnectionManager = {
  connect: () => Promise<void>;
  getPublishers: () => Record<string, RabbitMQPublisher>;
  isConnected: () => boolean;
  cleanup: () => Promise<void>;
};

export type RabbitMQConnectionManagerOptions = {
  connect?: typeof connect;
  setTimeout?: typeof setTimeout;
  /** Test seam: how long a publish waits for the broker's confirm (ms). */
  confirmTimeout?: number;
};

export const createRabbitMQConnectionManager = (
  queueConfig: RabbitMQQueue,
  context: QueueRuntimeContext,
  options: RabbitMQConnectionManagerOptions = {},
): RabbitMQConnectionManager => {
  const log = context.logger("rabbitmq").child({ queue: queueConfig.name });
  const connectFn = options.connect ?? connect;
  const setTimeoutFn = options.setTimeout ?? setTimeout;
  const confirmTimeout = options.confirmTimeout ?? CONFIRM_TIMEOUT;
  const state: RabbitMQConnectionState = {
    connection: null,
    channel: null,
    isConnecting: false,
  };

  // Publishers exist from the start: a send reads the channel when it runs, and
  // answers false while there is none.
  const publishers: Record<string, RabbitMQPublisher> = {};
  for (const exchange of queueConfig.exchanges) {
    for (const p of exchange.publishers) {
      const publisher = `${queueConfig.name}_${p.name}`;
      publishers[publisher] = {
        name: p.name,
        routingKey: p.routingKey,
        exchangeName: exchange.name,
        send: async (message: string | object) => {
          // No message body on the span — it is caller data.
          const span = context.startSpan("queue.publish", {
            kind: "producer",
            attributes: {
              "messaging.system": "rabbitmq",
              "messaging.destination.name": exchange.name,
              "graphoria.queue.publisher": publisher,
            },
          });
          const record = (outcome: "success" | "error") => {
            context.incMetric("graphoria_queue_messages_published_total", {
              broker: "rabbitmq",
              publisher,
              outcome,
            });
            if (outcome === "error") span?.setStatus("error");
            span?.end();
          };

          const channel = state.channel;
          if (!channel) {
            log.error("cannot send: channel not available");
            record("error");
            return false;
          }

          // The broker acks a message it took and nacks one it refused; a
          // channel that closes first (a missing exchange) fails it too, and so
          // does a confirm that does not come in time.
          let timer: Timer | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`no confirm within ${confirmTimeout} ms`)),
                confirmTimeout,
              );
              channel.publish(
                exchange.name,
                p.routingKey,
                Buffer.from(typeof message === "string" ? message : JSON.stringify(message)),
                p.options,
                (err) => (err ? reject(err) : resolve()),
              );
            }).finally(() => clearTimeout(timer));
          } catch (error) {
            log.error({ err: error, exchange: exchange.name }, "message not confirmed");
            record("error");
            return false;
          }
          record("success");
          return true;
        },
      };
    }
  }

  let reconnectAttempts = 0;
  let closing = false;

  const setupConnection = async (): Promise<void> => {
    if (state.isConnecting || closing) return;
    state.isConnecting = true;
    let rmqConnection: ChannelModel | undefined;
    // Until setup completes, the connection is this attempt's: a failure closes it
    // in the catch, which schedules the attempt's only reconnect.
    let established = false;
    let open = false;

    try {
      log.info("connecting");

      rmqConnection = await connectFn(queueConfig.connection);
      open = true;

      // Set up error handlers for reconnection
      rmqConnection.on("error", (err) => {
        log.error({ err }, "connection error");
      });

      rmqConnection.on("blocked", (reason) => {
        log.warn({ reason }, "connection blocked by the broker");
      });

      rmqConnection.on("unblocked", () => {
        log.info("connection unblocked");
      });

      rmqConnection.on("close", () => {
        open = false;
        if (!established) return;
        state.connection = null;
        state.channel = null;
        if (closing) {
          log.info("connection closed");
          return;
        }
        log.warn("connection closed, reconnecting");
        scheduleReconnect();
      });

      if (closing) {
        await rmqConnection.close();
        return;
      }
      const channel = await rmqConnection.createConfirmChannel();

      channel.on("error", (err) => {
        log.error({ err }, "channel error");
      });

      channel.on("close", () => {
        state.channel = null;
        if (closing) {
          log.info("channel closed");
          return;
        }
        log.warn("channel closed");
        // During setup, the setup's own failure closes the connection. After it,
        // the broker closed the channel alone (a publish to a missing exchange, a
        // cancelled consumer): closing the connection schedules the one
        // reconnect. A closing connection closes its channels before it emits
        // its own close, hence the microtask.
        if (!established) return;
        queueMicrotask(() => {
          if (!open || closing) return;
          void rmqConnection
            ?.close()
            .catch((err) => log.error({ err }, "error closing the connection"));
        });
      });

      if (queueConfig.autoSetup) {
        for (const exchange of queueConfig.exchanges) {
          await channel.assertExchange(exchange.name, exchange.type, exchange.options);
        }
      }

      // One unacknowledged message per consumer: a handler runs one message at a
      // time, as on Kafka, and a backlog is not delivered all at once.
      await channel.prefetch(1);

      // Set up queues and consumers
      for (const route of queueConfig.queues) {
        const queueName = route.queue ?? `${route.name}-${nanoid(10)}`;

        const durable = route.queueOptions?.durable ?? !!route.queue;
        const autoDelete = route.queueOptions?.autoDelete ?? !route.queue;
        const exclusive = route.queueOptions?.exclusive ?? !route.queue;

        if (!route.queue || (route.queue && queueConfig.autoSetup)) {
          await channel.assertQueue(queueName, {
            ...route.queueOptions,
            durable,
            autoDelete,
            exclusive,
          });

          for (const binding of route.bindings) {
            await channel.bindQueue(queueName, binding.exchange, binding.pattern);
          }
        }

        await startConsumer(
          context,
          queueConfig.name,
          route.name,
          queueName,
          channel,
          route.handler,
        );
      }

      if (closing) {
        await rmqConnection.close();
        return;
      }
      // amqplib handles a whole read before the setup resumes: a close that came
      // with the last reply has already closed the connection.
      if (!open) throw new Error("connection closed during setup");
      state.connection = rmqConnection;
      state.channel = channel;
      established = true;
      reconnectAttempts = 0;
      log.info("connected");
    } catch (error) {
      log.error({ err: error }, "connection failed");
      if (open) {
        await rmqConnection?.close().catch((err) => log.error({ err }, "error during cleanup"));
      }
      scheduleReconnect();
    } finally {
      state.isConnecting = false;
    }
  };

  const scheduleReconnect = () => {
    if (closing) return;

    const { initialDelay, maxDelay, multiplier, maxAttempts } =
      queueConfig.reconnect ?? DEFAULT_RECONNECT;
    if (maxAttempts > 0 && reconnectAttempts >= maxAttempts) {
      log.error({ attempts: reconnectAttempts }, "giving up reconnecting");
      return;
    }

    const delay = Math.min(initialDelay * Math.pow(multiplier, reconnectAttempts), maxDelay);
    reconnectAttempts++;

    log.info({ delay, attempt: reconnectAttempts }, "scheduling reconnect");

    setTimeoutFn(() => {
      void setupConnection().catch((error) => {
        log.error({ err: error }, "reconnect attempt failed");
      });
    }, delay);
  };

  const cleanup = async () => {
    closing = true;
    // One catch each: a channel that is already closing refuses close(), and
    // its connection still has to close.
    await state.channel
      ?.close()
      .catch((error) => log.error({ err: error }, "error during cleanup"));
    await state.connection
      ?.close()
      .catch((error) => log.error({ err: error }, "error during cleanup"));
  };

  return {
    connect: setupConnection,
    getPublishers: () => publishers,
    isConnected: () => state.connection !== null && state.channel !== null,
    cleanup,
  };
};

// ============================================================================
// Main Entry Point
// ============================================================================

export const startRabbitMQConnections = async (
  queues: RabbitMQQueue[],
  context: QueueRuntimeContext,
) => {
  const log = context.logger("rabbitmq");
  const managers = queues.map((queue) => createRabbitMQConnectionManager(queue, context));
  const publisherMap = managers.reduce<Record<string, RabbitMQPublisher>>(
    (acc, manager) => ({ ...acc, ...manager.getPublishers() }),
    {},
  );

  // Start connection attempts for all queues (non-blocking)
  // This allows the app to start even if RabbitMQ isn't immediately available
  // Failed connections will automatically retry in the background
  for (const manager of managers) {
    manager.connect().catch((error) => {
      log.warn({ err: error }, "initial connection failed, will retry");
    });
  }

  const sendMessage = async (publisherName: string, message: string | object, _key?: string) => {
    const publisher = publisherMap[publisherName];

    if (!publisher) {
      log.error({ publisher: publisherName }, "publisher not found");
      return false;
    }

    const result = await publisher.send(message);

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
    publisherMap: () => publisherMap,
    sendMessage,
    cleanup,
  };
};

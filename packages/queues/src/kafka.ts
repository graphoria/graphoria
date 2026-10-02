import { Kafka } from "kafkajs";
import { nanoid } from "nanoid";

import type { Consumer, EachMessagePayload, Producer, SASLOptions } from "kafkajs";
import type { KafkaConfig, QueueRuntimeContext } from "@graphoria/server";

// ============================================================================
// Reconnection Configuration
// ============================================================================

// Without a `reconnect` option: 1 s, doubling up to 30 s, forever.
const DEFAULT_RECONNECT = { initialDelay: 1000, maxDelay: 30000, multiplier: 2, maxAttempts: 0 };
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

const sendMessage = (
  context: QueueRuntimeContext,
  connectionName: string,
  name: string,
  payload: EachMessagePayload,
) => {
  context.emitSubscriptionEvent(`${connectionName}_${name}`, {
    data: {
      message: payload.message.value?.toString() || "",
      id: `${payload.partition}-${payload.message.offset}`,
    },
  });
};

export const startConsumer = async (
  context: QueueRuntimeContext,
  connectionName: string,
  name: string,
  topic: string,
  consumer: Consumer,
  handler?: KafkaConfig["queues"][number]["handler"],
) => {
  const log = context.logger("kafka").child({ queue: connectionName, consumer: name });

  await consumer.subscribe({ topic });

  await consumer.run({
    eachMessage: async (payload) => {
      const record = (outcome: "success" | "error") =>
        context.incMetric("graphoria_queue_messages_consumed_total", {
          broker: "kafka",
          queue: connectionName,
          consumer: name,
          outcome,
        });

      // A failure is logged and counted, never rethrown: kafkajs then commits
      // the offset, so the message is not redelivered.
      try {
        sendMessage(context, connectionName, name, payload);

        if (handler) {
          let parsedMessage: unknown = payload.message.value?.toString() ?? "";
          try {
            parsedMessage = JSON.parse(parsedMessage as string);
          } catch {
            // message is not JSON, proceed with raw string
          }

          await handler(parsedMessage, { cache: context.cache });
        }
        record("success");
      } catch (error) {
        record("error");
        log.error({ err: error }, "message processing failed");
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
  /** Consumers kafkajs is restarting after a crash: down until they rejoin. */
  rejoining: Set<Consumer>;
  isConnecting: boolean;
};

export type KafkaConnectionManager = {
  connect: () => Promise<void>;
  getPublishers: () => Record<string, KafkaPublisher>;
  isConnected: () => boolean;
  cleanup: () => Promise<void>;
};

export type KafkaDependencies = {
  /** Test seam: the manager builds its client through this. */
  createKafka?: (config: ConstructorParameters<typeof Kafka>[0]) => Kafka;
  /** Test seam: reconnects are scheduled through this. */
  setTimeout?: typeof setTimeout;
  /** Test seam: how long a consumer may take to connect (ms). */
  connectTimeout?: number;
};

export const createKafkaConnectionManager = (
  queueConfig: KafkaConfig,
  context: QueueRuntimeContext,
  {
    createKafka = (config) => new Kafka(config),
    setTimeout: setTimeoutFn = setTimeout,
    connectTimeout = CONNECTION_TIMEOUT,
  }: KafkaDependencies = {},
): KafkaConnectionManager => {
  if (queueConfig.type !== "kafka") {
    throw new Error("Invalid queue type for Kafka connection manager");
  }

  const log = context.logger("kafka").child({ queue: queueConfig.name });

  const state: KafkaConnectionState = {
    kafka: null,
    producer: null,
    consumers: [],
    rejoining: new Set(),
    isConnecting: false,
  };

  // Publishers exist from the start: a send reads the producer when it runs,
  // and answers false while there is none.
  const publishers: Record<string, KafkaPublisher> = {};
  for (const exchange of queueConfig.exchanges) {
    for (const p of exchange.publishers) {
      const publisher = `${queueConfig.name}_${p.name}`;
      publishers[publisher] = {
        name: p.name,
        topic: exchange.name,
        send: async (message: string | object, key?: string) => {
          // No message body on the span — it is caller data.
          const span = context.startSpan("queue.publish", {
            kind: "producer",
            attributes: {
              "messaging.system": "kafka",
              "messaging.destination.name": exchange.name,
              "graphoria.queue.publisher": publisher,
            },
          });
          const record = (outcome: "success" | "error") => {
            context.incMetric("graphoria_queue_messages_published_total", {
              broker: "kafka",
              publisher,
              outcome,
            });
            if (outcome === "error") span?.setStatus("error");
            span?.end();
          };

          if (!state.producer) {
            log.error("cannot send: producer not available");
            record("error");
            return false;
          }
          try {
            await state.producer.send({
              topic: exchange.name,
              messages: [
                {
                  // kafkajs hashes any key, an empty one too, to a single partition;
                  // a message without one goes to the partitions in turn.
                  key: key || p.routingKey || undefined,
                  value: typeof message === "string" ? message : JSON.stringify(message),
                  headers: p.options?.headers,
                },
              ],
            });
            record("success");
            return true;
          } catch (error) {
            log.error({ err: error, topic: exchange.name }, "failed to send message");
            record("error");
            return false;
          }
        },
      };
    }
  }

  let reconnectAttempts = 0;
  let shouldReconnect = true;
  // kafkajs restarts a crashed consumer even when it was disconnected during the
  // crash, and it rejoins its group untracked: one this manager let go of stays down.
  const released = new WeakSet<Consumer>();
  const release = (consumer: Consumer) => {
    released.add(consumer);
    return consumer.disconnect();
  };

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
    let producer: Producer | undefined;
    const consumers: Consumer[] = [];
    let connecting: { consumer: Consumer; connect: Promise<void> } | undefined;
    // Until setup completes, the producer is this attempt's: a failure disconnects
    // it in the catch, which schedules the attempt's only reconnect.
    let established = false;
    // A consumer kafkajs will not restart. Crashing while it joins its group, it
    // still lets run() resolve: the setup has to fail on it itself.
    let stopped = false;
    // A crash is how kafkajs reports a lost broker; a producer reports nothing.
    const rejoining = new Set<Consumer>();

    try {
      log.info("connecting");

      const connConfig = getConnectionConfig();

      // kafkajs's own retry backoff (5 retries from 300 ms, doubling) bounds a
      // send and lets a consumer crash on a lost broker within ~10 s; the
      // reconnects past that are this manager's.
      const kafka = createKafka({
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
      });

      producer = kafka.producer();

      // Only the queue's current producer: neither a setup's own (the catch
      // disconnects it) nor one a reset already let go of.
      producer.on("producer.disconnect", () => {
        if (state.producer !== producer) return;
        state.producer = null;
        if (!shouldReconnect) {
          log.info("producer disconnected");
          return;
        }
        log.warn("producer disconnected, reconnecting");
        scheduleReconnect();
      });

      await producer.connect();
      if (!shouldReconnect) {
        await producer.disconnect();
        return;
      }

      // Create consumers
      for (const route of queueConfig.queues) {
        const consumerGroup = route.groupId || `${route.name}-group-${nanoid(10)}`;

        const consumer: Consumer = kafka.consumer({
          groupId: consumerGroup,
          sessionTimeout: 30000,
          heartbeatInterval: 3000,
          // disconnect() waits for the fetch in flight: kafkajs's 5 s long-poll
          // outlasts the 1 s the server's shutdown gives its teardown.
          maxWaitTimeInMs: 500,
          // retries: 5 is kafkajs's consumer default, which a `retry` given here replaces.
          retry: { retries: 5, restartOnFailure: async () => !released.has(consumer) },
        });

        consumer.on("consumer.disconnect", () => {
          log.warn({ consumer: route.name }, "consumer disconnected");
        });

        consumer.on("consumer.crash", (event) => {
          log.error({ consumer: route.name, err: event.payload.error }, "consumer crashed");
          if (event.payload.restart) {
            log.info({ consumer: route.name }, "consumer will restart automatically");
            rejoining.add(consumer);
            return;
          }
          stopped = true;
          // Only the queue's current setup resets: once a reset let go of it,
          // another of its consumers stopping changes nothing.
          if (established && state.producer === producer) reset();
        });

        consumer.on("consumer.group_join", () => {
          if (rejoining.delete(consumer)) log.info({ consumer: route.name }, "consumer rejoined");
        });

        // Connect consumer with timeout to prevent hanging
        connecting = { consumer, connect: consumer.connect() };
        await withTimeout(
          connecting.connect,
          connectTimeout,
          `[Kafka] Consumer connection timeout for ${route.name}`,
        );
        connecting = undefined;
        consumers.push(consumer);

        for (const binding of route.bindings) {
          await startConsumer(
            context,
            queueConfig.name,
            route.name,
            binding.exchange,
            consumer,
            route.handler,
          );
        }
      }

      if (!shouldReconnect) {
        await Promise.all([producer.disconnect(), ...consumers.map(release)]);
        return;
      }
      if (stopped) throw new Error("a consumer stopped while joining its group");

      state.kafka = kafka;
      state.producer = producer;
      state.consumers = consumers;
      state.rejoining = rejoining;
      established = true;
      reconnectAttempts = 0;
      log.info("connected");
    } catch (error) {
      log.error({ err: error }, "connection failed");
      await Promise.all([producer?.disconnect(), ...consumers.map(release)]).catch((err) =>
        log.error({ err }, "error during cleanup"),
      );
      // A consumer whose connect timed out can still connect: disconnect it once it does.
      const late = connecting;
      void late?.connect
        .then(
          () => release(late.consumer),
          () => undefined,
        )
        .catch((err) => log.error({ err }, "error during cleanup"));
      scheduleReconnect();
    } finally {
      state.isConnecting = false;
    }
  };

  const scheduleReconnect = () => {
    if (!shouldReconnect) return;

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
      setupConnection();
    }, delay);
  };

  // A consumer kafkajs will not restart leaves the queue half up: let go of what
  // it holds and reconnect it once. The reconnect comes first, since a
  // disconnect can take as long as the broker is away.
  const reset = () => {
    const { producer, consumers } = state;
    state.kafka = null;
    state.producer = null;
    state.consumers = [];
    log.warn("a consumer stopped, reconnecting");
    scheduleReconnect();
    void Promise.all([producer?.disconnect(), ...consumers.map(release)]).catch((err) =>
      log.error({ err }, "error during reset"),
    );
  };

  const cleanup = async () => {
    shouldReconnect = false;
    try {
      if (state.producer) {
        await state.producer.disconnect();
      }
      await Promise.all(state.consumers.map(release));
    } catch (error) {
      log.error({ err: error }, "error during cleanup");
    }
  };

  return {
    connect: setupConnection,
    getPublishers: () => publishers,
    isConnected: () => state.producer !== null && state.rejoining.size === 0,
    cleanup,
  };
};

// ============================================================================
// Main Entry Point
// ============================================================================

export const startKafkaConnections = async (
  queues: KafkaConfig[],
  context: QueueRuntimeContext,
) => {
  const log = context.logger("kafka");
  const managers = queues.map((queue) => createKafkaConnectionManager(queue, context));
  const publisherMap = managers.reduce<Record<string, KafkaPublisher>>(
    (acc, manager) => ({ ...acc, ...manager.getPublishers() }),
    {},
  );

  // Start connection attempts for all queues (non-blocking)
  // This allows the app to start even if Kafka isn't immediately available
  // Failed connections will automatically retry in the background
  for (const manager of managers) {
    manager.connect().catch((error) => {
      log.warn({ err: error }, "initial connection failed, will retry");
    });
  }

  const sendMessage = async (publisherName: string, message: string | object, key?: string) => {
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
    publisherMap: () => publisherMap,
    sendMessage,
    cleanup,
  };
};

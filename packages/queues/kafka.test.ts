import { describe, expect, it } from "bun:test";

import type { Consumer, EachMessagePayload, Kafka, ProducerRecord } from "kafkajs";
import type { KafkaConfig, QueueRuntimeContext } from "@graphoria/server";

const { createKafkaConnectionManager, startConsumer } = await import("./src/kafka");
const { createFakeContext, stringAttribute } = await import("./test/fakeContext");

type SubscriberHandler = NonNullable<KafkaConfig["queues"][number]["handler"]>;

const minimalConfig = (): KafkaConfig =>
  ({
    type: "kafka",
    name: "test-q",
    enabled: true,
    autoSetup: false,
    connection: "localhost:9092",
    publishers: { p1: { topic: "t", routingKey: "rk" } },
    subscribers: {},
    topics: {},
    exchanges: [
      {
        name: "t",
        publishers: [{ name: "p1", resolverName: "test-q_p1", routingKey: "rk", options: {} }],
      },
    ],
    queues: [],
  }) as unknown as KafkaConfig;

const configWithSubscriber = (): KafkaConfig =>
  ({
    ...minimalConfig(),
    queues: [{ name: "sub1", groupId: "g", bindings: [{ exchange: "t", pattern: "" }] }],
  }) as unknown as KafkaConfig;

const configWithTwoSubscribers = (): KafkaConfig =>
  ({
    ...minimalConfig(),
    queues: [
      { name: "sub1", groupId: "g1", bindings: [{ exchange: "t", pattern: "" }] },
      { name: "sub2", groupId: "g2", bindings: [{ exchange: "t", pattern: "" }] },
    ],
  }) as unknown as KafkaConfig;

const fakeKafka = (send: () => Promise<unknown>) =>
  ({
    producer: () => ({
      on: () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      send,
    }),
    consumer: () => ({
      on: () => undefined,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async () => undefined,
      run: async () => undefined,
    }),
  }) as unknown as Kafka;

const fakeTimers = () => {
  const pending: Array<() => void> = [];
  const delays: number[] = [];
  const setTimeoutFn = ((cb: () => void, ms: number) => {
    pending.push(cb);
    delays.push(ms);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  // Fires the newest pending timer, as the clock would, and lets its attempt run.
  const fireLast = async () => {
    pending.at(-1)!();
    await Bun.sleep(0);
  };
  return { pending, delays, setTimeoutFn, fireLast };
};

// kafkajs emits producer.disconnect from disconnect() itself, never on a lost connection.
const emittingProducer = (onDisconnect: () => void) => {
  const handlers: Record<string, () => void> = {};
  return {
    on: (event: string, handler: () => void) => {
      handlers[event] = handler;
    },
    connect: async () => undefined,
    disconnect: async () => {
      onDisconnect();
      handlers["producer.disconnect"]?.();
    },
    send: async () => undefined,
  };
};

describe("Kafka metrics", () => {
  const connectedManager = async (context: QueueRuntimeContext, send: () => Promise<unknown>) => {
    const manager = createKafkaConnectionManager(minimalConfig(), context, {
      createKafka: () => fakeKafka(send),
    });
    await manager.connect();
    return manager;
  };

  it("counts a published message against its publisher", async () => {
    const { context, registry } = createFakeContext();
    const manager = await connectedManager(context, async () => undefined);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="kafka",outcome="success",publisher="test-q_p1"} 1',
    );
  });

  it("counts a publish the producer rejected as an error", async () => {
    const { context, registry } = createFakeContext();
    const manager = await connectedManager(context, async () => {
      throw new Error("broker down");
    });

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="kafka",outcome="error",publisher="test-q_p1"} 1',
    );
  });

  const consumeOnce = async (
    context: QueueRuntimeContext,
    payload: EachMessagePayload,
    handler?: SubscriberHandler,
  ) => {
    let deliver: ((payload: EachMessagePayload) => Promise<void>) | undefined;
    const consumer = {
      subscribe: async () => undefined,
      run: async ({ eachMessage }: { eachMessage: (p: EachMessagePayload) => Promise<void> }) => {
        deliver = eachMessage;
      },
    } as unknown as Consumer;

    await startConsumer(context, "test-q", "sub1", "t", consumer, handler);
    return deliver!(payload);
  };

  const message = (value: string) =>
    ({
      topic: "t",
      partition: 0,
      message: { value: Buffer.from(value), offset: "1" },
    }) as unknown as EachMessagePayload;

  it("counts a consumed message against its queue and consumer", async () => {
    const { context, registry } = createFakeContext();
    await consumeOnce(context, message("{}"));

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="kafka",consumer="sub1",outcome="success",queue="test-q"} 1',
    );
  });

  it("counts a message whose delivery threw as an error", async () => {
    const { context, registry } = createFakeContext();
    await consumeOnce(context, {} as EachMessagePayload);

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="kafka",consumer="sub1",outcome="error",queue="test-q"} 1',
    );
  });
});

describe("Kafka subscriber handler", () => {
  const consumeWith = async (context: QueueRuntimeContext, handler: SubscriberHandler) => {
    let deliver: ((payload: EachMessagePayload) => Promise<void>) | undefined;
    const consumer = {
      subscribe: async () => undefined,
      run: async ({ eachMessage }: { eachMessage: (p: EachMessagePayload) => Promise<void> }) => {
        deliver = eachMessage;
      },
    } as unknown as Consumer;
    await startConsumer(context, "test-q", "sub1", "t", consumer, handler);
    return deliver!({
      topic: "t",
      partition: 0,
      message: { value: Buffer.from('{"n":1}'), offset: "7" },
    } as unknown as EachMessagePayload);
  };

  it("runs the handler with the parsed message and the cache", async () => {
    const { context, events } = createFakeContext();
    const calls: unknown[][] = [];

    await consumeWith(context, (message, handlerContext) => {
      calls.push([message, handlerContext.cache]);
    });

    expect(calls).toEqual([[{ n: 1 }, context.cache]]);
    expect(events).toEqual([
      { key: "test-q_sub1", payload: { data: { message: '{"n":1}', id: "0-7" } } },
    ]);
  });

  it("counts a handler that threw as an error, and lets the offset commit", async () => {
    const { context, registry } = createFakeContext();

    // Resolving is what lets kafkajs commit the offset: the message is not redelivered.
    expect(
      await consumeWith(context, () => {
        throw new Error("poison");
      }),
    ).toBeUndefined();
    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="kafka",consumer="sub1",outcome="error",queue="test-q"} 1',
    );
  });
});

describe("Kafka tracing", () => {
  const connectedManager = async (context: QueueRuntimeContext, send: () => Promise<unknown>) => {
    const manager = createKafkaConnectionManager(minimalConfig(), context, {
      createKafka: () => fakeKafka(send),
    });
    await manager.connect();
    return manager;
  };

  it("spans a publish as a producer, naming the broker and the topic", async () => {
    const { context, spans } = createFakeContext();
    const manager = await connectedManager(context, async () => undefined);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    const [span] = await spans();

    expect(span!.name).toBe("queue.publish");
    expect(span!.kind).toBe(4);
    expect(stringAttribute(span!, "messaging.system")).toBe("kafka");
    expect(stringAttribute(span!, "messaging.destination.name")).toBe("t");
    expect(stringAttribute(span!, "graphoria.queue.publisher")).toBe("test-q_p1");
  });

  it("never carries the message body", async () => {
    const { context, spans } = createFakeContext();
    const manager = await connectedManager(context, async () => undefined);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "ana@acme.test" });

    expect(JSON.stringify(await spans())).not.toContain("ana@acme.test");
  });

  it("marks a publish the producer rejected as errored", async () => {
    const { context, spans } = createFakeContext();
    const manager = await connectedManager(context, async () => {
      throw new Error("broker down");
    });

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect((await spans())[0]!.status.code).toBe(2);
  });
});

describe("Kafka message key", () => {
  const keysSent = async (routingKey: string, key?: string) => {
    const keys: unknown[] = [];
    const config = minimalConfig();
    config.exchanges[0]!.publishers[0]!.routingKey = routingKey;
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(config, context, {
      createKafka: () =>
        fakeKafka(async (record?: ProducerRecord) => {
          keys.push(...record!.messages.map((message) => message.key));
        }),
    });
    await manager.connect();
    await manager.getPublishers()["test-q_p1"]!.send("m", key);
    return keys;
  };

  // Any key, even an empty one, sends every message to the partition its hash picks.
  it("sends no key for a publisher without a routing key", async () => {
    expect(await keysSent("")).toEqual([undefined]);
  });

  it("sends the routing key, or the caller's key over it", async () => {
    expect(await keysSent("rk")).toEqual(["rk"]);
    expect(await keysSent("rk", "order-42")).toEqual(["order-42"]);
  });
});

describe("Kafka publishers before the first connect", () => {
  const neverConnects = () =>
    ({
      producer: () => ({
        on: () => undefined,
        connect: () => new Promise<void>(() => undefined),
        disconnect: async () => undefined,
        send: async () => undefined,
      }),
      consumer: () => ({}),
    }) as unknown as Kafka;

  it("lists the configured publishers while the first connect is pending", () => {
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(minimalConfig(), context, {
      createKafka: neverConnects,
    });
    void manager.connect();

    expect(Object.keys(manager.getPublishers())).toEqual(["test-q_p1"]);
  });

  it("answers false for a publish before the first connect, and counts it", async () => {
    const { context, registry, logs } = createFakeContext();
    const manager = createKafkaConnectionManager(minimalConfig(), context, {
      createKafka: neverConnects,
    });
    void manager.connect();

    expect(await manager.getPublishers()["test-q_p1"]?.send("m")).toBe(false);
    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="kafka",outcome="error",publisher="test-q_p1"} 1',
    );
    expect(logs.map((log) => log.msg)).toContain("cannot send: producer not available");
  });
});

describe("cleanup during connect", () => {
  it("closes a producer that connects after cleanup", async () => {
    let resolveConnect!: () => void;
    let disconnects = 0;
    let consumerConnects = 0;
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () =>
        ({
          producer: () => ({
            on: () => undefined,
            connect: () =>
              new Promise<void>((resolve) => {
                resolveConnect = resolve;
              }),
            disconnect: async () => {
              disconnects++;
            },
            send: async () => undefined,
          }),
          consumer: () => ({
            on: () => undefined,
            connect: async () => {
              consumerConnects++;
            },
            disconnect: async () => undefined,
            subscribe: async () => undefined,
            run: async () => undefined,
          }),
        }) as unknown as Kafka,
    });

    const connecting = manager.connect();
    await Bun.sleep(0);
    await manager.cleanup();
    resolveConnect();
    await connecting;

    expect(disconnects).toBe(1);
    expect(consumerConnects).toBe(0);
    expect(manager.isConnected()).toBe(false);
  });

  it("closes producer and consumers when cleanup runs during the consumer loop", async () => {
    let resolveConsumerConnect!: () => void;
    let producerDisconnects = 0;
    let consumerDisconnects = 0;
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () =>
        ({
          producer: () => ({
            on: () => undefined,
            connect: async () => undefined,
            disconnect: async () => {
              producerDisconnects++;
            },
            send: async () => undefined,
          }),
          consumer: () => ({
            on: () => undefined,
            connect: () =>
              new Promise<void>((resolve) => {
                resolveConsumerConnect = resolve;
              }),
            disconnect: async () => {
              consumerDisconnects++;
            },
            subscribe: async () => undefined,
            run: async () => undefined,
          }),
        }) as unknown as Kafka,
    });

    const connecting = manager.connect();
    await Bun.sleep(0);
    await manager.cleanup();
    resolveConsumerConnect();
    await connecting;

    expect(producerDisconnects).toBe(1);
    expect(consumerDisconnects).toBe(1);
    expect(manager.isConnected()).toBe(false);
  });

  it("closes the producer and connected consumers when a consumer connect fails after cleanup", async () => {
    let rejectSecondConnect!: (error: Error) => void;
    let producerDisconnects = 0;
    let firstConsumerDisconnects = 0;
    const consumers = [
      {
        on: () => undefined,
        connect: async () => undefined,
        disconnect: async () => {
          firstConsumerDisconnects++;
        },
        subscribe: async () => undefined,
        run: async () => undefined,
      },
      {
        on: () => undefined,
        connect: () =>
          new Promise<void>((_resolve, reject) => {
            rejectSecondConnect = reject;
          }),
        disconnect: async () => undefined,
        subscribe: async () => undefined,
        run: async () => undefined,
      },
    ];
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithTwoSubscribers(), context, {
      createKafka: () =>
        ({
          producer: () => ({
            on: () => undefined,
            connect: async () => undefined,
            disconnect: async () => {
              producerDisconnects++;
            },
            send: async () => undefined,
          }),
          consumer: () => consumers.shift(),
        }) as unknown as Kafka,
    });

    const connecting = manager.connect();
    await Bun.sleep(0);
    await manager.cleanup();
    rejectSecondConnect(new Error("coordinator not available"));
    await connecting;

    expect(producerDisconnects).toBe(1);
    expect(firstConsumerDisconnects).toBe(1);
    expect(manager.isConnected()).toBe(false);
  });

  it("closes a consumer whose subscribe fails after cleanup", async () => {
    let rejectSubscribe!: (error: Error) => void;
    let producerDisconnects = 0;
    let consumerDisconnects = 0;
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () =>
        ({
          producer: () => ({
            on: () => undefined,
            connect: async () => undefined,
            disconnect: async () => {
              producerDisconnects++;
            },
            send: async () => undefined,
          }),
          consumer: () => ({
            on: () => undefined,
            connect: async () => undefined,
            disconnect: async () => {
              consumerDisconnects++;
            },
            subscribe: () =>
              new Promise<void>((_resolve, reject) => {
                rejectSubscribe = reject;
              }),
            run: async () => undefined,
          }),
        }) as unknown as Kafka,
    });

    const connecting = manager.connect();
    await Bun.sleep(0);
    await manager.cleanup();
    rejectSubscribe(new Error("broker gone"));
    await connecting;

    expect(producerDisconnects).toBe(1);
    expect(consumerDisconnects).toBe(1);
    expect(manager.isConnected()).toBe(false);
  });
});

describe("Kafka consumer crash", () => {
  type CrashEvent = { payload: { error: Error; restart: boolean } };

  // kafkajs disconnects a crashed consumer itself, then emits consumer.crash.
  const crashingKafka = (crashWhileJoining?: CrashEvent) => {
    const counts = { producerDisconnects: 0, consumerDisconnects: 0 };
    const handlers: Record<string, (event: CrashEvent) => void> = {};
    const kafka = {
      producer: () =>
        emittingProducer(() => {
          counts.producerDisconnects++;
        }),
      consumer: () => ({
        on: (event: string, handler: (event: CrashEvent) => void) => {
          handlers[event] = handler;
        },
        connect: async () => undefined,
        disconnect: async () => {
          counts.consumerDisconnects++;
        },
        subscribe: async () => undefined,
        // kafkajs's run() resolves even when joining the group crashed.
        run: async () => {
          if (crashWhileJoining) handlers["consumer.crash"]?.(crashWhileJoining);
        },
      }),
    } as unknown as Kafka;
    return {
      kafka,
      counts,
      crash: (event: CrashEvent) => handlers["consumer.crash"]!(event),
      join: () => handlers["consumer.group_join"]?.({} as CrashEvent),
    };
  };

  const crashed = (restart: boolean): CrashEvent => ({
    payload: { error: new Error("group coordinator gone"), restart },
  });

  it("reconnects the queue once when a consumer stops for good", async () => {
    const fake = crashingKafka();
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: timers.setTimeoutFn,
    });
    await manager.connect();
    expect(manager.isConnected()).toBe(true);

    fake.crash(crashed(false));
    await Bun.sleep(0);

    expect(manager.isConnected()).toBe(false);
    expect(fake.counts.producerDisconnects).toBe(1);
    expect(fake.counts.consumerDisconnects).toBe(1);
    expect(timers.pending).toHaveLength(1);
  });

  it("reconnects the queue once when every consumer stops for good", async () => {
    const crashes: Array<(event: CrashEvent) => void> = [];
    const kafka = {
      producer: () => emittingProducer(() => undefined),
      consumer: () => ({
        on: (event: string, handler: (event: CrashEvent) => void) => {
          if (event === "consumer.crash") crashes.push(handler);
        },
        connect: async () => undefined,
        disconnect: async () => undefined,
        subscribe: async () => undefined,
        run: async () => undefined,
      }),
    } as unknown as Kafka;
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithTwoSubscribers(), context, {
      createKafka: () => kafka,
      setTimeout: timers.setTimeoutFn,
    });
    await manager.connect();

    // One cause, such as a revoked ACL, stops both consumers.
    for (const crash of crashes) crash(crashed(false));
    await Bun.sleep(0);

    expect(crashes).toHaveLength(2);
    expect(timers.pending).toHaveLength(1);
  });

  it("leaves a consumer that will restart to kafkajs", async () => {
    const fake = crashingKafka();
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: timers.setTimeoutFn,
    });
    await manager.connect();

    fake.crash(crashed(true));
    await Bun.sleep(0);

    expect(fake.counts.producerDisconnects).toBe(0);
    expect(timers.pending).toHaveLength(0);
  });

  it("reports a consumer that will restart as down until it rejoins its group", async () => {
    const fake = crashingKafka();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: fakeTimers().setTimeoutFn,
    });
    await manager.connect();

    // A broker outage: kafkajs restarts the consumer until it can rejoin.
    fake.crash(crashed(true));
    expect(manager.isConnected()).toBe(false);

    fake.join();
    expect(manager.isConnected()).toBe(true);
  });

  it("reports a consumer that crashed while joining as down until it joins", async () => {
    const fake = crashingKafka(crashed(true));
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: timers.setTimeoutFn,
    });

    await manager.connect();
    expect(manager.isConnected()).toBe(false);
    expect(timers.pending).toHaveLength(0);

    fake.join();
    expect(manager.isConnected()).toBe(true);
  });

  it("fails the setup when a consumer stops for good while joining", async () => {
    const fake = crashingKafka(crashed(false));
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: timers.setTimeoutFn,
    });

    await manager.connect();

    expect(manager.isConnected()).toBe(false);
    expect(fake.counts.producerDisconnects).toBe(1);
    expect(timers.pending).toHaveLength(1);
  });

  // kafkajs asks restartOnFailure once it has disconnected a crashed consumer
  // itself: a consumer disconnected meanwhile would rejoin its group untracked.
  const restartHooks = () => {
    const hooks: Array<() => Promise<boolean>> = [];
    const crashes: Array<(event: CrashEvent) => void> = [];
    const kafka = {
      producer: () => emittingProducer(() => undefined),
      consumer: (options?: { retry?: { restartOnFailure?: () => Promise<boolean> } }) => {
        hooks.push(options?.retry?.restartOnFailure ?? (async () => true));
        return {
          on: (event: string, handler: (event: CrashEvent) => void) => {
            if (event === "consumer.crash") crashes.push(handler);
          },
          connect: async () => undefined,
          disconnect: async () => undefined,
          subscribe: async () => undefined,
          run: async () => undefined,
        };
      },
    } as unknown as Kafka;
    return { kafka, hooks, crashes };
  };

  it("lets kafkajs restart a crashed consumer of the queue's current setup", async () => {
    const fake = restartHooks();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: fakeTimers().setTimeoutFn,
    });
    await manager.connect();

    expect(await fake.hooks[0]!()).toBe(true);
  });

  it("keeps a consumer down that cleanup let go of", async () => {
    const fake = restartHooks();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () => fake.kafka,
      setTimeout: fakeTimers().setTimeoutFn,
    });
    await manager.connect();

    await manager.cleanup();

    expect(await fake.hooks[0]!()).toBe(false);
  });

  it("keeps the other consumers down once a reset let go of them", async () => {
    const fake = restartHooks();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithTwoSubscribers(), context, {
      createKafka: () => fake.kafka,
      setTimeout: fakeTimers().setTimeoutFn,
    });
    await manager.connect();

    fake.crashes[0]!(crashed(false));
    await Bun.sleep(0);

    expect(await fake.hooks[1]!()).toBe(false);
  });
});

describe("Kafka retries", () => {
  // kafkajs/src/retry: the n-th wait is initialRetryTime × multiplier^n, capped
  // at maxRetryTime and drawn within ±factor of that; there are `retries` waits.
  // Producer and consumer merge their own retry over the client's.
  const KAFKAJS_DEFAULTS = {
    maxRetryTime: 30_000,
    initialRetryTime: 300,
    factor: 0.2,
    multiplier: 2,
    retries: 5,
  };
  type RetryOptions = Partial<typeof KAFKAJS_DEFAULTS>;

  const effectiveRetries = async () => {
    const seen: { client?: RetryOptions; producer?: RetryOptions; consumer?: RetryOptions } = {};
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: (config) => {
        seen.client = config.retry as RetryOptions | undefined;
        return {
          producer: (options?: { retry?: RetryOptions }) => {
            seen.producer = options?.retry;
            return emittingProducer(() => undefined);
          },
          consumer: (options?: { retry?: RetryOptions }) => {
            seen.consumer = options?.retry;
            return {
              on: () => undefined,
              connect: async () => undefined,
              disconnect: async () => undefined,
              subscribe: async () => undefined,
              run: async () => undefined,
            };
          },
        } as unknown as Kafka;
      },
    });
    await manager.connect();
    return {
      producer: { ...KAFKAJS_DEFAULTS, ...seen.client, ...seen.producer },
      consumer: { ...KAFKAJS_DEFAULTS, ...seen.client, ...seen.consumer },
    };
  };

  const totalWait = (retry: typeof KAFKAJS_DEFAULTS) => {
    let total = 0;
    for (let n = 0; n < retry.retries; n++) {
      total += Math.min(retry.initialRetryTime * retry.multiplier ** n, retry.maxRetryTime);
    }
    return total;
  };

  it("gives up a send within seconds while the broker is away", async () => {
    const { producer } = await effectiveRetries();

    expect(totalWait(producer)).toBeLessThan(15_000);
  });

  it("lets a consumer crash within seconds of a lost broker, so readiness reports it", async () => {
    const { consumer } = await effectiveRetries();

    expect(totalWait(consumer)).toBeLessThan(15_000);
  });

  it("never draws a negative wait", async () => {
    const { producer, consumer } = await effectiveRetries();

    expect(producer.factor).toBeLessThan(1);
    expect(consumer.factor).toBeLessThan(1);
  });
});

describe("Kafka reconnect option", () => {
  const failing = (reconnect?: KafkaConfig["reconnect"]) => {
    let connects = 0;
    const timers = fakeTimers();
    const { context, logs } = createFakeContext();
    const manager = createKafkaConnectionManager({ ...minimalConfig(), reconnect }, context, {
      createKafka: () =>
        ({
          producer: () => ({
            on: () => undefined,
            connect: async () => {
              connects++;
              throw new Error("refused");
            },
            disconnect: async () => undefined,
          }),
        }) as unknown as Kafka,
      setTimeout: timers.setTimeoutFn,
    });
    return { manager, timers, logs, connects: () => connects };
  };

  it("waits initialDelay, then multiplies it, up to maxDelay", async () => {
    const { manager, timers } = failing({
      initialDelay: 100,
      maxDelay: 500,
      multiplier: 3,
      maxAttempts: 0,
    });

    await manager.connect();
    for (let n = 0; n < 3; n++) await timers.fireLast();

    expect(timers.delays).toEqual([100, 300, 500, 500]);
  });

  it("stops after maxAttempts reconnects, and says so once", async () => {
    const { manager, timers, logs, connects } = failing({
      initialDelay: 100,
      maxDelay: 500,
      multiplier: 2,
      maxAttempts: 2,
    });

    await manager.connect();
    await timers.fireLast();
    await timers.fireLast();

    expect(connects()).toBe(3);
    expect(timers.pending).toHaveLength(2);
    expect(
      logs.filter((log) => log.level === "error" && log.msg === "giving up reconnecting"),
    ).toHaveLength(1);
    expect(manager.isConnected()).toBe(false);
  });

  it("waits 1 s, doubling up to 30 s, without the option", async () => {
    const { manager, timers } = failing();

    await manager.connect();
    for (let n = 0; n < 6; n++) await timers.fireLast();

    expect(timers.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("Kafka failed setup", () => {
  it("disconnects what a failed setup connected and reconnects once", async () => {
    let producerDisconnects = 0;
    let firstConsumerDisconnects = 0;
    const consumers = [
      {
        on: () => undefined,
        connect: async () => undefined,
        disconnect: async () => {
          firstConsumerDisconnects++;
        },
        subscribe: async () => undefined,
        run: async () => undefined,
      },
      {
        on: () => undefined,
        connect: async () => {
          throw new Error("coordinator not available");
        },
        disconnect: async () => undefined,
        subscribe: async () => undefined,
        run: async () => undefined,
      },
    ];
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithTwoSubscribers(), context, {
      createKafka: () =>
        ({
          producer: () =>
            emittingProducer(() => {
              producerDisconnects++;
            }),
          consumer: () => consumers.shift(),
        }) as unknown as Kafka,
      setTimeout: timers.setTimeoutFn,
    });

    await manager.connect();

    expect(producerDisconnects).toBe(1);
    expect(firstConsumerDisconnects).toBe(1);
    expect(timers.pending).toHaveLength(1);
  });

  it("disconnects a consumer whose connect timed out once it connects", async () => {
    let resolveConnect!: () => void;
    let consumerDisconnects = 0;
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createKafkaConnectionManager(configWithSubscriber(), context, {
      createKafka: () =>
        ({
          producer: () => emittingProducer(() => undefined),
          consumer: () => ({
            on: () => undefined,
            connect: () =>
              new Promise<void>((resolve) => {
                resolveConnect = resolve;
              }),
            disconnect: async () => {
              consumerDisconnects++;
            },
            subscribe: async () => undefined,
            run: async () => undefined,
          }),
        }) as unknown as Kafka,
      setTimeout: timers.setTimeoutFn,
      connectTimeout: 1,
    });

    await manager.connect();
    expect(consumerDisconnects).toBe(0);

    resolveConnect();
    await Bun.sleep(0);

    expect(consumerDisconnects).toBe(1);
  });
});

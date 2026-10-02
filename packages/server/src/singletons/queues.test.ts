import { afterEach, describe, expect, it } from "bun:test";

import type { QueueAdapter, QueueAdapterType, QueueRuntimeContext } from "../queues/adapter";
import type { QueueConfig } from "../types/zod/queue";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const queues = await import("./queues");
const { QueueConfigZod } = await import("../types/zod/queue");
const { queryEventEmitter } = await import("../configuration/gql/handleGraphQLSubscriptionFactory");
const { InvalidationHelper } = await import("./cache/registry");
const { logger } = await import("../logging");
const { incMetric } = await import("../observability/metrics");
const { startSpan } = await import("../observability/tracing");

afterEach(async () => {
  await queues.queueManager?.cleanup?.();
  queues.setQueueManager(undefined);
});

const fakeAdapter = (name: QueueAdapterType) => {
  const calls: { queues: QueueConfig[]; context: QueueRuntimeContext }[] = [];
  const sent: string[] = [];
  let cleanups = 0;
  const adapter: QueueAdapter = {
    start: async (queues, context) => {
      calls.push({ queues, context });
      return {
        publisherMap: () => ({ [`${name}_p1`]: { name: "p1" } }),
        sendMessage: async (publisherName) => {
          sent.push(publisherName);
          return true;
        },
        connections: () => [{ type: name, name: "q", connected: true }],
        cleanup: async () => {
          cleanups++;
        },
      };
    },
  };
  return { adapter, calls, sent, cleanups: () => cleanups };
};

const rabbitmqQueue = { type: "rabbitmq", name: "r" } as QueueConfig;
const kafkaQueue = { type: "kafka", name: "k" } as QueueConfig;

const fakePackage = (registers: Partial<Record<QueueAdapterType, QueueAdapter>>) => async () => ({
  registerQueueAdapters: (setAdapter: (type: QueueAdapterType, adapter: QueueAdapter) => void) => {
    for (const [type, adapter] of Object.entries(registers)) {
      setAdapter(type as QueueAdapterType, adapter);
    }
  },
});

describe("instantiateQueues", () => {
  it("starts each adapter with only its own queues and the shared context", async () => {
    const rabbitmq = fakeAdapter("rabbitmq");
    const kafka = fakeAdapter("kafka");

    await queues.instantiateQueues(
      [{ type: "rabbitmq", name: "r" } as QueueConfig, { type: "kafka", name: "k" } as QueueConfig],
      { adapters: { rabbitmq: rabbitmq.adapter, kafka: kafka.adapter } },
    );

    expect(rabbitmq.calls[0]!.queues.every((q) => q.type === "rabbitmq")).toBe(true);
    expect(rabbitmq.calls[0]!.queues).toHaveLength(1);
    expect(kafka.calls[0]!.queues.every((q) => q.type === "kafka")).toBe(true);
    expect(kafka.calls[0]!.queues).toHaveLength(1);

    const context = rabbitmq.calls[0]!.context;
    expect(context.emitSubscriptionEvent).toBe(queryEventEmitter.sendDataUpdate);
    expect(context.cache).toBe(InvalidationHelper);
    expect(context.logger).toBe(logger);
    expect(context.incMetric).toBe(incMetric);
    expect(context.startSpan).toBe(startSpan);
    expect(kafka.calls[0]!.context).toBe(context);
  });

  it("reaches every adapter from the combined cleanup", async () => {
    const rabbitmq = fakeAdapter("rabbitmq");
    const kafka = fakeAdapter("kafka");

    await queues.instantiateQueues(
      [{ type: "rabbitmq", name: "r" } as QueueConfig, { type: "kafka", name: "k" } as QueueConfig],
      { adapters: { rabbitmq: rabbitmq.adapter, kafka: kafka.adapter } },
    );
    await queues.queueManager!.cleanup!();

    expect(rabbitmq.cleanups()).toBe(1);
    expect(kafka.cleanups()).toBe(1);
  });

  it("dispatches sendMessage to the adapter that owns the publisher", async () => {
    const rabbitmq = fakeAdapter("rabbitmq");
    const kafka = fakeAdapter("kafka");

    await queues.instantiateQueues(
      [{ type: "rabbitmq", name: "r" } as QueueConfig, { type: "kafka", name: "k" } as QueueConfig],
      { adapters: { rabbitmq: rabbitmq.adapter, kafka: kafka.adapter } },
    );

    await queues.queueManager!.sendMessage("kafka_p1", "m");
    expect(kafka.sent).toEqual(["kafka_p1"]);
    expect(rabbitmq.sent).toEqual([]);

    expect(await queues.queueManager!.sendMessage("nope", "m")).toBe(false);
  });

  it("sets a manager without discovery when there are no queues", async () => {
    let loads = 0;
    await queues.instantiateQueues([], {
      importQueues: async () => {
        loads++;
        return undefined;
      },
    });

    expect(loads).toBe(0);
    expect(queues.queueManager!.publisherMap()).toEqual({});
    expect(await queues.queueManager!.sendMessage("x", "m")).toBe(false);
  });

  // createGraphQLEngine never runs instantiateQueues; its handlers get the manager all the same.
  it("hands out a manager without queues before instantiateQueues runs", async () => {
    expect(queues.queueManager.publisherMap()).toEqual({});
    expect(await queues.queueManager.sendMessage("events_orderCreated", "m")).toBe(false);
    expect(queues.queueManager.connections()).toEqual([]);
  });
});

describe("adapter discovery", () => {
  it("discovers the installed @graphoria/queues", async () => {
    const config = QueueConfigZod.parse({
      type: "rabbitmq",
      name: "events",
      connection: { hostname: "127.0.0.1", port: 1 },
      subscribers: { s1: { topic: "t" } },
    });

    await queues.instantiateQueues([config]);

    expect(queues.queueManager!.connections()).toEqual([
      { type: "rabbitmq", name: "events", connected: false },
    ]);
  });

  it("fails boot naming the package when it is not installed", async () => {
    await expect(
      queues.instantiateQueues([rabbitmqQueue], { importQueues: async () => undefined }),
    ).rejects.toThrow('queue type "rabbitmq" requires @graphoria/queues (add it to dependencies)');
  });

  it("surfaces the package's own error when it fails to load", async () => {
    const loadError = new Error("Cannot find package 'amqplib'");

    await expect(
      queues.instantiateQueues([rabbitmqQueue], {
        importQueues: async () => {
          throw loadError;
        },
      }),
    ).rejects.toBe(loadError);
  });

  it("starts the adapters the package registers", async () => {
    const rabbitmq = fakeAdapter("rabbitmq");

    await queues.instantiateQueues([rabbitmqQueue], {
      importQueues: fakePackage({ rabbitmq: rabbitmq.adapter }),
    });

    expect(rabbitmq.calls).toHaveLength(1);
    expect(rabbitmq.calls[0]!.queues).toEqual([rabbitmqQueue]);
  });

  it("never loads the package when every queue type has an adapter", async () => {
    let loads = 0;
    const rabbitmq = fakeAdapter("rabbitmq");

    await queues.instantiateQueues([rabbitmqQueue], {
      adapters: { rabbitmq: rabbitmq.adapter },
      importQueues: async () => {
        loads++;
        return undefined;
      },
    });

    expect(loads).toBe(0);
    expect(rabbitmq.calls).toHaveLength(1);
  });

  it("keeps an adapter registered with setQueueAdapter over a discovered one", async () => {
    const registered = fakeAdapter("kafka");
    const discovered = { rabbitmq: fakeAdapter("rabbitmq"), kafka: fakeAdapter("kafka") };
    // The registry outlives this test, so it runs last.
    queues.setQueueAdapter("kafka", registered.adapter);

    await queues.instantiateQueues([rabbitmqQueue, kafkaQueue], {
      importQueues: fakePackage({
        rabbitmq: discovered.rabbitmq.adapter,
        kafka: discovered.kafka.adapter,
      }),
    });

    expect(registered.calls).toHaveLength(1);
    expect(discovered.kafka.calls).toHaveLength(0);
    expect(discovered.rabbitmq.calls).toHaveLength(1);
  });
});

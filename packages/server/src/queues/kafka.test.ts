import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Consumer, EachMessagePayload, Kafka } from "kafkajs";
import type { KafkaConfig } from "../types/zod/queue";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const { createKafkaConnectionManager, startConsumer } = await import("./kafka");
const { configureMetrics, createRegistry, setMetricsRegistry } = await import(
  "../observability/metrics"
);

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

describe("Kafka metrics", () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
    setMetricsRegistry(registry);
    configureMetrics({ enabled: true });
  });

  afterEach(() => {
    setMetricsRegistry(null);
    configureMetrics({ enabled: false });
  });

  const connectedManager = async (send: () => Promise<unknown>) => {
    const manager = createKafkaConnectionManager(minimalConfig(), {
      createKafka: () => fakeKafka(send),
    });
    await manager.connect();
    return manager;
  };

  it("counts a published message against its publisher", async () => {
    const manager = await connectedManager(async () => undefined);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="kafka",outcome="success",publisher="test-q_p1"} 1',
    );
  });

  it("counts a publish the producer rejected as an error", async () => {
    const manager = await connectedManager(async () => {
      throw new Error("broker down");
    });

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="kafka",outcome="error",publisher="test-q_p1"} 1',
    );
  });

  const consumeOnce = async (payload: EachMessagePayload) => {
    let deliver: ((payload: EachMessagePayload) => Promise<void>) | undefined;
    const consumer = {
      subscribe: async () => undefined,
      run: async ({ eachMessage }: { eachMessage: (p: EachMessagePayload) => Promise<void> }) => {
        deliver = eachMessage;
      },
    } as unknown as Consumer;

    await startConsumer("test-q", "sub1", "t", consumer, "group1");
    await deliver!(payload);
  };

  const message = (value: string) =>
    ({
      topic: "t",
      partition: 0,
      message: { value: Buffer.from(value), offset: "1" },
    }) as unknown as EachMessagePayload;

  it("counts a consumed message against its queue and consumer", async () => {
    await consumeOnce(message("{}"));

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="kafka",consumer="sub1",outcome="success",queue="test-q"} 1',
    );
  });

  it("counts a message whose delivery threw as an error", async () => {
    await consumeOnce({} as EachMessagePayload);

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="kafka",consumer="sub1",outcome="error",queue="test-q"} 1',
    );
  });
});

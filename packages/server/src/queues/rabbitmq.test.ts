import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "events";

import type { Channel, ChannelModel, connect as connectFn } from "amqplib";
import type { RabbitMQConfig } from "../types/zod/queue";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const { createRabbitMQConnectionManager, startConsumer } = await import("./rabbitmq");
const { configureMetrics, createRegistry, setMetricsRegistry } = await import(
  "../observability/metrics"
);

type FakeChannel = EventEmitter & Partial<Channel>;
type FakeConnection = EventEmitter & {
  createChannel: () => Promise<Channel>;
  close: () => Promise<void>;
};

const makeFake = () => {
  const channel = new EventEmitter() as FakeChannel;
  channel.publish = () => true;
  channel.consume = async () => ({}) as ReturnType<Channel["consume"]>;
  channel.close = async () => undefined;

  const conn = new EventEmitter() as FakeConnection;
  conn.createChannel = async () => channel as Channel;
  conn.close = async () => undefined;
  return { conn, channel };
};

const minimalConfig = (): RabbitMQConfig =>
  ({
    type: "rabbitmq",
    name: "test-q",
    enabled: true,
    autoSetup: false,
    connection: { hostname: "x", port: 5672, vhost: "/" },
    publishers: {
      p1: { topic: "t", routingKey: "rk", persistent: true },
    },
    subscribers: {},
    topics: {},
    exchanges: [
      {
        name: "t",
        type: "topic",
        publishers: [
          {
            name: "p1",
            resolverName: "test-q_p1",
            routingKey: "rk",
            options: {},
          },
        ],
      },
    ],
    queues: [],
  }) as unknown as RabbitMQConfig;

describe("RabbitMQ reconnection", () => {
  it("rebuilds publishers and fires onPublishersChanged after a close → reconnect cycle", async () => {
    const fakes = [makeFake(), makeFake()];
    let connectCallCount = 0;

    const fakeConnect: typeof connectFn = (async () => {
      const slot = fakes[connectCallCount++];
      return slot.conn as ChannelModel;
    }) as unknown as typeof connectFn;

    let scheduledTask: (() => void) | null = null;
    const fakeSetTimeout = ((cb: () => void) => {
      scheduledTask = cb;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const manager = createRabbitMQConnectionManager(minimalConfig(), {
      connect: fakeConnect,
      setTimeout: fakeSetTimeout,
    });

    let changeCount = 0;
    manager.onPublishersChanged(() => {
      changeCount++;
    });

    await manager.connect();

    expect(connectCallCount).toBe(1);
    expect(manager.isConnected()).toBe(true);
    expect(Object.keys(manager.getPublishers())).toEqual(["test-q_p1"]);
    expect(changeCount).toBe(1);

    fakes[0].conn.emit("close");
    expect(manager.isConnected()).toBe(false);
    expect(typeof scheduledTask).toBe("function");

    scheduledTask!();
    await new Promise((r) => setImmediate(r));

    expect(connectCallCount).toBe(2);
    expect(manager.isConnected()).toBe(true);
    expect(Object.keys(manager.getPublishers())).toEqual(["test-q_p1"]);
    expect(changeCount).toBe(2);
  });

  it("schedules reconnect when initial connect throws", async () => {
    const fakeConnect = (async () => {
      throw new Error("boom");
    }) as unknown as typeof connectFn;

    let scheduled = false;
    const fakeSetTimeout = (() => {
      scheduled = true;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const manager = createRabbitMQConnectionManager(minimalConfig(), {
      connect: fakeConnect,
      setTimeout: fakeSetTimeout,
    });

    await manager.connect();

    expect(scheduled).toBe(true);
    expect(manager.isConnected()).toBe(false);
  });
});

describe("RabbitMQ metrics", () => {
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

  const connectedManager = async (channelPublishes: boolean) => {
    const { conn, channel } = makeFake();
    channel.publish = () => channelPublishes;
    const manager = createRabbitMQConnectionManager(minimalConfig(), {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
    });
    await manager.connect();
    return manager;
  };

  it("counts a published message against its publisher", async () => {
    const manager = await connectedManager(true);

    manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="rabbitmq",outcome="success",publisher="test-q_p1"} 1',
    );
  });

  it("counts a publish the broker refused as an error", async () => {
    const manager = await connectedManager(false);

    manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="rabbitmq",outcome="error",publisher="test-q_p1"} 1',
    );
  });

  const consumeOnce = async (handler?: () => void) => {
    const { channel } = makeFake();
    let deliver: ((msg: unknown) => Promise<void>) | undefined;
    channel.consume = (async (_queue: string, cb: (msg: unknown) => Promise<void>) => {
      deliver = cb;
      return {} as ReturnType<Channel["consume"]>;
    }) as unknown as Channel["consume"];
    channel.ack = () => undefined;
    channel.nack = () => undefined;

    await startConsumer("test-q", "sub1", "q1", channel as Channel, handler);
    await deliver!({ content: Buffer.from("{}"), fields: { deliveryTag: 1 } });
  };

  it("counts a consumed message against its queue and consumer", async () => {
    await consumeOnce();

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="rabbitmq",consumer="sub1",outcome="success",queue="test-q"} 1',
    );
  });

  it("counts a message whose handler threw as an error", async () => {
    await consumeOnce(() => {
      throw new Error("boom");
    });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="rabbitmq",consumer="sub1",outcome="error",queue="test-q"} 1',
    );
  });
});

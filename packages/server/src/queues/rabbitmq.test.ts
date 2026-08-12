import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";

import type { Channel, ChannelModel, connect as connectFn } from "amqplib";
import type { RabbitMQConfig } from "../types/zod/queue";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const { createRabbitMQConnectionManager } = await import("./rabbitmq");

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

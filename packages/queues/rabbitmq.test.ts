import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";

import type { Channel, ChannelModel, ConfirmChannel, connect as connectFn } from "amqplib";
import type { QueueRuntimeContext, RabbitMQConfig } from "@graphoria/server";

const { createRabbitMQConnectionManager, startConsumer } = await import("./src/rabbitmq");
const { createFakeContext, stringAttribute } = await import("./test/fakeContext");

type FakeChannel = EventEmitter & Partial<ConfirmChannel>;
type FakeConnection = EventEmitter & {
  createChannel: () => Promise<Channel>;
  createConfirmChannel: () => Promise<ConfirmChannel>;
  close: () => Promise<void>;
};

type ConfirmCallback = (err: Error | null) => void;

// A confirm channel reports the broker's verdict through publish's callback;
// publish's own return value is only write-buffer backpressure.
const confirmingPublish =
  (verdict: () => Error | null) =>
  (...args: unknown[]) => {
    (args[4] as ConfirmCallback | undefined)?.(verdict());
    return true;
  };

const makeFake = () => {
  const channel = new EventEmitter() as FakeChannel;
  channel.publish = confirmingPublish(() => null) as ConfirmChannel["publish"];
  channel.prefetch = async () => ({}) as ReturnType<Channel["prefetch"]>;
  channel.consume = async () => ({}) as ReturnType<Channel["consume"]>;
  channel.close = async () => {
    channel.emit("close");
  };

  // amqplib emits "close" on a deliberate close() too.
  const conn = new EventEmitter() as FakeConnection;
  conn.createChannel = async () => channel as Channel;
  conn.createConfirmChannel = async () => channel as ConfirmChannel;
  conn.close = async () => {
    conn.emit("close");
  };
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

describe("RabbitMQ reconnection", () => {
  it("reconnects after a close, keeping its publishers", async () => {
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

    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: fakeConnect,
      setTimeout: fakeSetTimeout,
    });

    await manager.connect();

    expect(connectCallCount).toBe(1);
    expect(manager.isConnected()).toBe(true);
    expect(Object.keys(manager.getPublishers())).toEqual(["test-q_p1"]);

    fakes[0].conn.emit("close");
    expect(manager.isConnected()).toBe(false);
    expect(typeof scheduledTask).toBe("function");

    scheduledTask!();
    await new Promise((r) => setImmediate(r));

    expect(connectCallCount).toBe(2);
    expect(manager.isConnected()).toBe(true);
    expect(Object.keys(manager.getPublishers())).toEqual(["test-q_p1"]);
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

    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: fakeConnect,
      setTimeout: fakeSetTimeout,
    });

    await manager.connect();

    expect(scheduled).toBe(true);
    expect(manager.isConnected()).toBe(false);
  });
});

describe("RabbitMQ reconnect option", () => {
  const failing = (reconnect?: RabbitMQConfig["reconnect"]) => {
    let connects = 0;
    const timers = fakeTimers();
    const { context, logs } = createFakeContext();
    const manager = createRabbitMQConnectionManager({ ...minimalConfig(), reconnect }, context, {
      connect: (async () => {
        connects++;
        throw new Error("refused");
      }) as unknown as typeof connectFn,
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

describe("RabbitMQ cleanup", () => {
  it("schedules no reconnect when cleanup closes the connection", async () => {
    const { conn } = makeFake();
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });
    await manager.connect();

    await manager.cleanup();

    expect(timers.pending).toHaveLength(0);
    expect(manager.isConnected()).toBe(false);
  });

  it("closes the connection when closing its channel fails", async () => {
    const { conn, channel } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      setTimeout: fakeTimers().setTimeoutFn,
    });
    await manager.connect();
    // amqplib refuses to close a channel that is already closing, as one is
    // while the broker cancels its consumer.
    channel.close = async () => {
      throw new Error("Channel closing");
    };

    await manager.cleanup();

    expect(closed).toBe(1);
  });

  it("does not connect from a reconnect that was pending at cleanup", async () => {
    let connects = 0;
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => {
        connects++;
        throw new Error("refused");
      }) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });
    await manager.connect();
    expect(timers.pending).toHaveLength(1);

    await manager.cleanup();
    timers.pending[0]!();
    await new Promise((r) => setImmediate(r));

    expect(connects).toBe(1);
  });

  it("schedules no reconnect when a connect fails after cleanup", async () => {
    let rejectConnect!: (error: Error) => void;
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (() =>
        new Promise<ChannelModel>((_resolve, reject) => {
          rejectConnect = reject;
        })) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });

    const connecting = manager.connect();
    await manager.cleanup();
    rejectConnect(new Error("refused"));
    await connecting;

    expect(timers.pending).toHaveLength(0);
  });

  it("closes a connection that opens after cleanup", async () => {
    const { conn } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    let resolveConnect!: (connection: ChannelModel) => void;
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (() =>
        new Promise<ChannelModel>((resolve) => {
          resolveConnect = resolve;
        })) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });

    const connecting = manager.connect();
    await manager.cleanup();
    resolveConnect(conn as ChannelModel);
    await connecting;

    expect(closed).toBe(1);
    expect(manager.isConnected()).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });

  it("closes a connection whose channel setup outlasts cleanup", async () => {
    const { conn, channel } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    let resolveChannel!: (value: ConfirmChannel) => void;
    conn.createConfirmChannel = () =>
      new Promise<ConfirmChannel>((resolve) => {
        resolveChannel = resolve;
      });
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });

    const connecting = manager.connect();
    await Bun.sleep(0);
    await manager.cleanup();
    resolveChannel(channel as ConfirmChannel);
    await connecting;

    expect(closed).toBe(1);
    expect(manager.isConnected()).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });

  it("closes the connection when channel setup fails after cleanup", async () => {
    const { conn } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    let rejectChannel!: (error: Error) => void;
    conn.createConfirmChannel = () =>
      new Promise<ConfirmChannel>((_resolve, reject) => {
        rejectChannel = reject;
      });
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });

    const connecting = manager.connect();
    await Bun.sleep(0);
    await manager.cleanup();
    rejectChannel(new Error("channel_max reached"));
    await connecting;

    expect(closed).toBe(1);
    expect(manager.isConnected()).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });
});

describe("RabbitMQ failed setup", () => {
  it("closes the connection of a setup that failed and reconnects once", async () => {
    const { conn } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    conn.createConfirmChannel = async () => {
      throw new Error("channel_max reached");
    };
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });

    await manager.connect();

    expect(closed).toBe(1);
    expect(timers.pending).toHaveLength(1);
  });

  it("reconnects once when the broker closes the connection during setup", async () => {
    const { conn, channel } = makeFake();
    let closeCalls = 0;
    conn.close = async () => {
      closeCalls++;
    };
    // amqplib emits "close" on the connection before it rejects the pending call.
    channel.assertExchange = (async () => {
      conn.emit("close");
      throw new Error("Connection closed: 541 (INTERNAL-ERROR)");
    }) as unknown as Channel["assertExchange"];
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(
      { ...minimalConfig(), autoSetup: true },
      context,
      {
        connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
        setTimeout: timers.setTimeoutFn,
      },
    );

    await manager.connect();

    expect(timers.pending).toHaveLength(1);
    expect(closeCalls).toBe(0);
  });

  it("reconnects when the broker's close comes in the same read as the setup's last reply", async () => {
    const { conn, channel } = makeFake();
    let closeCalls = 0;
    conn.close = async () => {
      closeCalls++;
    };
    // amqplib handles every frame of a read before the setup resumes: the
    // reply settles the call, then the close frame closes the channel and the
    // connection.
    channel.consume = (async () => {
      channel.emit("close");
      conn.emit("close");
      return {};
    }) as unknown as Channel["consume"];
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(
      { ...minimalConfig(), queues: [{ name: "sub1", queue: "orders", bindings: [] }] },
      context,
      {
        connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
        setTimeout: timers.setTimeoutFn,
      },
    );

    await manager.connect();

    expect(manager.isConnected()).toBe(false);
    expect(timers.pending).toHaveLength(1);
    expect(closeCalls).toBe(0);
  });

  it("fails the setup when the broker refuses a consume", async () => {
    const { conn, channel } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    channel.consume = (async () => {
      throw new Error("Operation failed: BasicConsume; 404 (NOT-FOUND)");
    }) as unknown as Channel["consume"];
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(
      { ...minimalConfig(), queues: [{ name: "sub1", queue: "missing", bindings: [] }] },
      context,
      {
        connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
        setTimeout: timers.setTimeoutFn,
      },
    );

    await manager.connect();

    expect(manager.isConnected()).toBe(false);
    expect(closed).toBe(1);
    expect(timers.pending).toHaveLength(1);
  });
});

describe("RabbitMQ broker closes on a live connection", () => {
  const connected = async (config: RabbitMQConfig = minimalConfig()) => {
    const { conn, channel } = makeFake();
    let closed = 0;
    conn.close = async () => {
      closed++;
      conn.emit("close");
    };
    let deliver: ((msg: unknown) => Promise<void>) | undefined;
    channel.consume = (async (_queue: string, cb: (msg: unknown) => Promise<void>) => {
      deliver = cb;
      return {} as ReturnType<Channel["consume"]>;
    }) as unknown as Channel["consume"];
    const timers = fakeTimers();
    const { context, logs } = createFakeContext();
    const manager = createRabbitMQConnectionManager(config, context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      setTimeout: timers.setTimeoutFn,
    });
    await manager.connect();
    return {
      manager,
      conn,
      channel,
      timers,
      logs,
      closed: () => closed,
      deliver: (msg: unknown) => deliver!(msg),
    };
  };

  it("reconnects once when the broker closes the channel", async () => {
    const { manager, channel, timers, closed } = await connected();

    // A publish to a missing exchange: 404, and the broker closes the channel only.
    channel.emit("close");
    await Bun.sleep(0);

    expect(closed()).toBe(1);
    expect(timers.pending).toHaveLength(1);
    expect(manager.isConnected()).toBe(false);
  });

  it("does not close a connection the broker is closing", async () => {
    const { conn, channel, timers, closed } = await connected();

    // amqplib closes the channels first, then emits the connection's close.
    channel.emit("close");
    conn.emit("close");
    await Bun.sleep(0);

    expect(closed()).toBe(0);
    expect(timers.pending).toHaveLength(1);
  });

  it("reconnects once when the broker cancels a consumer", async () => {
    const { manager, timers, logs, closed, deliver } = await connected({
      ...minimalConfig(),
      queues: [{ name: "sub1", queue: "orders", bindings: [] }],
    } as RabbitMQConfig);

    // A deleted queue: amqplib hands the consumer null.
    await deliver(null);
    await Bun.sleep(0);

    expect(closed()).toBe(1);
    expect(timers.pending).toHaveLength(1);
    expect(manager.isConnected()).toBe(false);
    expect(
      logs.filter((log) => log.level === "warn" && log.fields.consumer === "sub1"),
    ).toHaveLength(1);
  });

  it("leaves a channel closed during setup to the setup's own failure", async () => {
    const { conn, channel } = makeFake();
    let closed = 0;
    // amqplib emits "close" once the broker confirms, not inside close().
    conn.close = async () => {
      closed++;
      await Bun.sleep(0);
      conn.emit("close");
    };
    // amqplib closes the channel, then rejects the call the broker refused.
    channel.assertExchange = (async () => {
      channel.emit("close");
      throw new Error("Channel closed by server: 406 (PRECONDITION-FAILED)");
    }) as unknown as Channel["assertExchange"];
    const timers = fakeTimers();
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(
      { ...minimalConfig(), autoSetup: true },
      context,
      {
        connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
        setTimeout: timers.setTimeoutFn,
      },
    );

    await manager.connect();
    await Bun.sleep(0);

    expect(closed).toBe(1);
    expect(timers.pending).toHaveLength(1);
  });
});

describe("RabbitMQ publishers before the first connect", () => {
  const neverConnects = (() => new Promise(() => undefined)) as unknown as typeof connectFn;

  it("lists the configured publishers while the first connect is pending", () => {
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: neverConnects,
    });
    void manager.connect();

    expect(Object.keys(manager.getPublishers())).toEqual(["test-q_p1"]);
  });

  it("answers false for a publish before the first connect, and counts it", async () => {
    const { context, registry, logs } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: neverConnects,
    });
    void manager.connect();

    expect(await manager.getPublishers()["test-q_p1"]?.send("m")).toBe(false);
    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="rabbitmq",outcome="error",publisher="test-q_p1"} 1',
    );
    expect(logs.map((log) => log.msg)).toContain("cannot send: channel not available");
  });
});

describe("RabbitMQ publisher confirms", () => {
  const connected = async (publish: ConfirmChannel["publish"], confirmTimeout?: number) => {
    const { conn, channel } = makeFake();
    channel.publish = publish;
    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
      confirmTimeout,
    });
    await manager.connect();
    return manager.getPublishers()["test-q_p1"]!;
  };

  it("answers true once the broker confirms the message", async () => {
    const publisher = await connected(confirmingPublish(() => null) as ConfirmChannel["publish"]);

    expect(await publisher.send("m")).toBe(true);
  });

  it("answers false when the broker nacks the message", async () => {
    const publisher = await connected(
      confirmingPublish(() => new Error("message nacked")) as ConfirmChannel["publish"],
    );

    expect(await publisher.send("m")).toBe(false);
  });

  it("answers false when the channel closes before the broker confirms", async () => {
    let confirm: ConfirmCallback | undefined;
    const publisher = await connected(((...args: unknown[]) => {
      confirm = args[4] as ConfirmCallback;
      return true;
    }) as ConfirmChannel["publish"]);

    const sent = publisher.send("m");
    // A publish to a missing exchange: the broker closes the channel, and
    // amqplib fails every unconfirmed message.
    confirm!(new Error("channel closed"));

    expect(await sent).toBe(false);
  });

  it("answers false on a channel amqplib already knows is closed", async () => {
    const publisher = await connected((() => {
      throw Object.assign(new Error("Channel closed"), { name: "IllegalOperationError" });
    }) as ConfirmChannel["publish"]);

    expect(await publisher.send("m")).toBe(false);
  });

  it("answers false when the broker does not confirm in time", async () => {
    // A broker in a memory or disk alarm confirms only once the alarm clears.
    const publisher = await connected((() => true) as ConfirmChannel["publish"], 20);

    const answer = await Promise.race([
      publisher.send("m"),
      Bun.sleep(1_000).then(() => "no answer"),
    ]);

    expect(answer).toBe(false);
  });

  it("logs the broker's reason when it blocks the connection, and when it unblocks it", async () => {
    const { conn } = makeFake();
    const { context, logs } = createFakeContext();
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
    });
    await manager.connect();

    conn.emit("blocked", "low on memory");
    conn.emit("unblocked");

    expect(logs.find((log) => log.msg === "connection blocked by the broker")).toMatchObject({
      level: "warn",
      fields: { reason: "low on memory" },
    });
    expect(logs.find((log) => log.msg === "connection unblocked")?.level).toBe("info");
  });
});

describe("RabbitMQ metrics", () => {
  const connectedManager = async (context: QueueRuntimeContext, confirmed: boolean) => {
    const { conn, channel } = makeFake();
    channel.publish = confirmingPublish(() =>
      confirmed ? null : new Error("message nacked"),
    ) as ConfirmChannel["publish"];
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
    });
    await manager.connect();
    return manager;
  };

  it("counts a published message against its publisher", async () => {
    const { context, registry } = createFakeContext();
    const manager = await connectedManager(context, true);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="rabbitmq",outcome="success",publisher="test-q_p1"} 1',
    );
  });

  it("counts a publish the broker refused as an error", async () => {
    const { context, registry } = createFakeContext();
    const manager = await connectedManager(context, false);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_published_total{broker="rabbitmq",outcome="error",publisher="test-q_p1"} 1',
    );
  });

  const consumeOnce = async (context: QueueRuntimeContext, handler?: () => void) => {
    const { channel } = makeFake();
    let deliver: ((msg: unknown) => Promise<void>) | undefined;
    channel.consume = (async (_queue: string, cb: (msg: unknown) => Promise<void>) => {
      deliver = cb;
      return {} as ReturnType<Channel["consume"]>;
    }) as unknown as Channel["consume"];
    channel.ack = () => undefined;
    channel.nack = () => undefined;

    await startConsumer(context, "test-q", "sub1", "q1", channel as Channel, handler);
    await deliver!({ content: Buffer.from("{}"), fields: { deliveryTag: 1 } });
  };

  it("counts a consumed message against its queue and consumer", async () => {
    const { context, registry } = createFakeContext();
    await consumeOnce(context);

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="rabbitmq",consumer="sub1",outcome="success",queue="test-q"} 1',
    );
  });

  it("counts a message whose handler threw as an error", async () => {
    const { context, registry } = createFakeContext();
    await consumeOnce(context, () => {
      throw new Error("boom");
    });

    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="rabbitmq",consumer="sub1",outcome="error",queue="test-q"} 1',
    );
  });
});

describe("RabbitMQ settling", () => {
  // amqplib throws IllegalOperationError from ack / nack on a closed channel.
  const closingChannel = () => {
    const { channel } = makeFake();
    let deliver: ((msg: unknown) => Promise<void>) | undefined;
    let closed = false;
    const settled: string[] = [];
    const settle = (kind: string) => () => {
      if (closed) {
        throw Object.assign(new Error("Channel closed"), { name: "IllegalOperationError" });
      }
      settled.push(kind);
    };
    channel.consume = (async (_queue: string, cb: (msg: unknown) => Promise<void>) => {
      deliver = cb;
      return {} as ReturnType<Channel["consume"]>;
    }) as unknown as Channel["consume"];
    channel.ack = settle("ack");
    channel.nack = settle("nack");
    return {
      channel,
      settled,
      deliver: () => deliver!({ content: Buffer.from("{}"), fields: { deliveryTag: 1 } }),
      close: () => {
        closed = true;
      },
    };
  };

  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  };

  it("counts a handler that finished after its channel closed, and warns", async () => {
    const { context, registry, logs } = createFakeContext();
    const fake = closingChannel();
    const handlerGate = gate();
    await startConsumer(
      context,
      "test-q",
      "sub1",
      "q1",
      fake.channel as Channel,
      () => handlerGate.opened,
    );

    const delivery = fake.deliver();
    fake.close();
    handlerGate.open();

    expect(await delivery).toBeUndefined();
    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="rabbitmq",consumer="sub1",outcome="success",queue="test-q"} 1',
    );
    expect(logs.filter((log) => log.level === "warn")).toHaveLength(1);
  });

  it("counts a handler that failed after its channel closed, and warns", async () => {
    const { context, registry, logs } = createFakeContext();
    const fake = closingChannel();
    const handlerGate = gate();
    await startConsumer(context, "test-q", "sub1", "q1", fake.channel as Channel, async () => {
      await handlerGate.opened;
      throw new Error("boom");
    });

    const delivery = fake.deliver();
    fake.close();
    handlerGate.open();

    expect(await delivery).toBeUndefined();
    expect(registry.render()).toContain(
      'graphoria_queue_messages_consumed_total{broker="rabbitmq",consumer="sub1",outcome="error",queue="test-q"} 1',
    );
    expect(logs.filter((log) => log.level === "warn")).toHaveLength(1);
  });

  it("acks once a handler succeeds on an open channel", async () => {
    const { context } = createFakeContext();
    const fake = closingChannel();
    await startConsumer(context, "test-q", "sub1", "q1", fake.channel as Channel, () => undefined);

    await fake.deliver();

    expect(fake.settled).toEqual(["ack"]);
  });
});

describe("RabbitMQ subscription events", () => {
  it("carries the delivery tag as a string id", async () => {
    const { channel } = makeFake();
    let deliver: ((msg: unknown) => Promise<void>) | undefined;
    channel.consume = (async (_queue: string, cb: (msg: unknown) => Promise<void>) => {
      deliver = cb;
      return {} as ReturnType<Channel["consume"]>;
    }) as unknown as Channel["consume"];
    channel.ack = () => undefined;
    const { context, events } = createFakeContext();
    await startConsumer(context, "test-q", "sub1", "q1", channel as Channel);

    await deliver!({
      content: Buffer.from("hello"),
      fields: { deliveryTag: 1, redelivered: false },
    });

    expect(events).toEqual([
      { key: "test-q_sub1", payload: { data: { message: "hello", id: "1" } } },
    ]);
  });
});

describe("RabbitMQ redelivery", () => {
  const failOnce = async (redelivered: boolean) => {
    const { channel } = makeFake();
    let deliver: ((msg: unknown) => Promise<void>) | undefined;
    const nacks: unknown[][] = [];
    channel.consume = (async (_queue: string, cb: (msg: unknown) => Promise<void>) => {
      deliver = cb;
      return {} as ReturnType<Channel["consume"]>;
    }) as unknown as Channel["consume"];
    channel.ack = () => undefined;
    channel.nack = (...args: unknown[]) => {
      nacks.push(args.slice(1));
    };
    const { context } = createFakeContext();
    await startConsumer(context, "test-q", "sub1", "q1", channel as Channel, () => {
      throw new Error("poison");
    });

    await deliver!({ content: Buffer.from("{}"), fields: { deliveryTag: 1, redelivered } });
    return nacks;
  };

  it("puts a message whose handler failed back on the queue", async () => {
    expect(await failOnce(false)).toEqual([[false, true]]);
  });

  it("drops a redelivered message whose handler failed again", async () => {
    expect(await failOnce(true)).toEqual([[false, false]]);
  });
});

describe("RabbitMQ tracing", () => {
  const connectedManager = async (context: QueueRuntimeContext, confirmed: boolean) => {
    const { conn, channel } = makeFake();
    channel.publish = confirmingPublish(() =>
      confirmed ? null : new Error("message nacked"),
    ) as ConfirmChannel["publish"];
    const manager = createRabbitMQConnectionManager(minimalConfig(), context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
    });
    await manager.connect();
    return manager;
  };

  it("spans a publish as a producer, naming the broker and the exchange", async () => {
    const { context, spans } = createFakeContext();
    const manager = await connectedManager(context, true);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    const [span] = await spans();

    expect(span!.name).toBe("queue.publish");
    expect(span!.kind).toBe(4);
    expect(stringAttribute(span!, "messaging.system")).toBe("rabbitmq");
    expect(stringAttribute(span!, "messaging.destination.name")).toBe("t");
    expect(stringAttribute(span!, "graphoria.queue.publisher")).toBe("test-q_p1");
  });

  it("never carries the message body", async () => {
    const { context, spans } = createFakeContext();
    const manager = await connectedManager(context, true);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "ana@acme.test" });

    expect(JSON.stringify(await spans())).not.toContain("ana@acme.test");
  });

  it("marks a publish the broker refused as errored", async () => {
    const { context, spans } = createFakeContext();
    const manager = await connectedManager(context, false);

    await manager.getPublishers()["test-q_p1"]!.send({ hello: "world" });

    expect((await spans())[0]!.status.code).toBe(2);
  });
});

describe("RabbitMQ prefetch", () => {
  it("asks for one unacknowledged message per consumer before it consumes", async () => {
    const { conn, channel } = makeFake();
    const calls: unknown[][] = [];
    channel.prefetch = (async (...args: unknown[]) => {
      calls.push(["prefetch", ...args]);
    }) as unknown as ConfirmChannel["prefetch"];
    channel.consume = (async (queue: string) => {
      calls.push(["consume", queue]);
      return {};
    }) as unknown as ConfirmChannel["consume"];
    const { context } = createFakeContext();
    const config = {
      ...minimalConfig(),
      queues: [{ name: "sub1", queue: "orders", bindings: [] }],
    } as unknown as RabbitMQConfig;
    const manager = createRabbitMQConnectionManager(config, context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
    });

    await manager.connect();

    expect(calls).toEqual([
      ["prefetch", 1],
      ["consume", "orders"],
    ]);
  });
});

describe("subscriber queue declaration", () => {
  const managerWith = async (route: RabbitMQConfig["queues"][number]) => {
    const channel = new EventEmitter() as EventEmitter & Partial<ConfirmChannel>;
    let captured: Record<string, unknown> = {};
    channel.assertQueue = (async (_queue: string, options?: unknown) => {
      captured = options as Record<string, unknown>;
      return {} as ReturnType<Channel["assertQueue"]>;
    }) as unknown as Channel["assertQueue"];
    channel.bindQueue = async () => ({}) as ReturnType<Channel["bindQueue"]>;
    channel.prefetch = async () => ({}) as ReturnType<Channel["prefetch"]>;
    channel.consume = async () => ({}) as ReturnType<Channel["consume"]>;
    channel.close = async () => {
      channel.emit("close");
    };

    const conn = new EventEmitter() as EventEmitter & {
      createConfirmChannel: () => Promise<ConfirmChannel>;
      close: () => Promise<void>;
    };
    conn.createConfirmChannel = async () => channel as ConfirmChannel;
    conn.close = async () => {
      conn.emit("close");
    };

    const config = {
      ...minimalConfig(),
      autoSetup: true,
      exchanges: [],
      queues: [route],
    } as RabbitMQConfig;

    const { context } = createFakeContext();
    const manager = createRabbitMQConnectionManager(config, context, {
      connect: (async () => conn as ChannelModel) as unknown as typeof connectFn,
    });
    await manager.connect();
    return captured;
  };

  it("declares a generated subscriber queue as exclusive", async () => {
    const captured = await managerWith({
      name: "sub1",
      bindings: [{ exchange: "t", pattern: "#" }],
    } as RabbitMQConfig["queues"][number]);
    expect(captured.exclusive).toBe(true);
  });

  it("declares a named subscriber queue non-exclusive when not configured", async () => {
    const captured = await managerWith({
      name: "sub1",
      queue: "named",
      bindings: [],
    } as RabbitMQConfig["queues"][number]);
    expect(captured.exclusive).toBe(false);
  });

  it("honors an explicit exclusive on a named subscriber queue", async () => {
    const captured = await managerWith({
      name: "sub1",
      queue: "named",
      bindings: [],
      queueOptions: { exclusive: true },
    } as RabbitMQConfig["queues"][number]);
    expect(captured.exclusive).toBe(true);
  });
});

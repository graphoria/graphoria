import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { QueueConfig } from "../../config";
import type { StartedServer } from "./harness";
import type { TcpProxy } from "./tcpProxy";

import { RABBITMQ } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";
import { createTcpProxy } from "./tcpProxy";

/**
 * Every test gets a vhost of its own on the shared broker: its connections and
 * queues are counted there, and deleting the vhost removes what the test left.
 */

const ENGINE = "sqlite" as const;
const DEADLINE_MS = 15_000;
// The management API lists a new connection about 5 s after it opens
// (measured), and drops a closed one at once.
const LISTING_LAG_MS = 6_000;

const SUBSCRIPTION = "subscription { events_orders { id message } }";
const PUBLISH = "mutation ($data: String!) { events_orderCreated(data: $data) }";

type BrokerConnection = { name: string };
type BrokerQueue = { name: string; durable: boolean; exclusive: boolean; auto_delete: boolean };

const api = async (method: string, path: string, body?: unknown) => {
  const response = await Bun.fetch(`${RABBITMQ.managementUrl}/api${path}`, {
    method,
    headers: {
      authorization: `Basic ${btoa(`${RABBITMQ.username}:${RABBITMQ.password}`)}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return response;
};

const vhosts: string[] = [];

const createVhost = async () => {
  const name = `graphoria-${crypto.randomUUID()}`;
  await api("PUT", `/vhosts/${name}`);
  await api("PUT", `/permissions/${name}/${RABBITMQ.username}`, {
    configure: ".*",
    write: ".*",
    read: ".*",
  });
  vhosts.push(name);
  return name;
};

const connections = async (vhost: string) =>
  (await (await api("GET", `/vhosts/${vhost}/connections`)).json()) as BrokerConnection[];

const queuesOn = async (vhost: string) =>
  (await (await api("GET", `/queues/${vhost}`)).json()) as BrokerQueue[];

/** Takes up to 10 messages off a queue, reading the queue itself rather than its statistics. */
const takeMessages = async (vhost: string, queue: string) =>
  (await (
    await api("POST", `/queues/${vhost}/${queue}/get`, {
      count: 10,
      ackmode: "ack_requeue_false",
      encoding: "auto",
    })
  ).json()) as { payload: string }[];

const eventually = async (
  condition: () => boolean | Promise<boolean>,
  deadlineMs = DEADLINE_MS,
) => {
  const deadline = Date.now() + deadlineMs;
  while (!(await condition())) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(100);
  }
  return true;
};

const queueConfig = (
  vhost: string,
  overrides: Partial<Extract<QueueConfig, { type: "rabbitmq" }>> = {},
  port: number = RABBITMQ.port,
): QueueConfig => ({
  type: "rabbitmq",
  name: "events",
  connection: {
    hostname: RABBITMQ.host,
    port,
    username: RABBITMQ.username,
    password: RABBITMQ.password,
    vhost,
  },
  publishers: { orderCreated: { topic: "orders", routingKey: "order.created" } },
  subscribers: { orders: { topic: "orders", pattern: "order.*" } },
  topics: { orders: {} },
  ...overrides,
});

describe.skipIf(!integrationEnabled)("rabbitmq queues", () => {
  let started: StartedServer | undefined;
  let proxy: TcpProxy | undefined;

  const boot = async (queue: QueueConfig) => {
    started = await startServer({ engine: ENGINE, skipSeed: true, config: { queues: [queue] } });
    return started;
  };

  const readiness = async (server: StartedServer) =>
    (await Bun.fetch(`http://localhost:${server.context.server.port}/health/ready`)).status;

  const ready = (server: StartedServer) =>
    eventually(async () => (await readiness(server)) === 200);

  const publish = async (server: StartedServer, data: string) =>
    (await server.context.gql<{ events_orderCreated: boolean }>(PUBLISH, { data }, { admin: true }))
      .data?.events_orderCreated;

  beforeAll(async () => {
    await seedEngine(ENGINE);
  });

  afterEach(async () => {
    await started?.stop();
    started = undefined;
    await proxy?.close();
    proxy = undefined;
  });

  afterAll(async () => {
    await Promise.all(vhosts.map((vhost) => api("DELETE", `/vhosts/${vhost}`)));
  });

  it("delivers a published message to a subscription", async () => {
    const server = await boot(queueConfig(await createVhost()));
    expect(await ready(server)).toBe(true);

    const client = await server.context.subscribe(SUBSCRIPTION, { admin: true });
    try {
      expect(await publish(server, "hello")).toBe(true);
      const data = await client.nextData<{ events_orders: { id: unknown; message: string } }>();
      // The schema declares `id: String!`.
      expect(data.events_orders).toEqual({ id: expect.any(String), message: "hello" });
    } finally {
      client.close();
    }
  });

  it("declares a generated subscriber queue exclusive and honors exclusive on a named one", async () => {
    const vhost = await createVhost();
    const server = await boot(
      queueConfig(vhost, {
        subscribers: {
          orders: { topic: "orders" },
          audit: { topic: "orders", queue: "audit", exclusive: true },
        },
      }),
    );
    expect(await ready(server)).toBe(true);

    const queues = await queuesOn(vhost);
    expect(queues.find((queue) => queue.name.startsWith("orders-"))?.exclusive).toBe(true);
    expect(queues.find((queue) => queue.name === "audit")?.exclusive).toBe(true);
  });

  it(
    "reconnects once after the broker closes the connection, and delivers again",
    async () => {
      const vhost = await createVhost();
      const server = await boot(queueConfig(vhost));
      expect(await ready(server)).toBe(true);
      expect(await eventually(async () => (await connections(vhost)).length === 1)).toBe(true);
      const [connection] = await connections(vhost);

      await api("DELETE", `/connections/${encodeURIComponent(connection!.name)}`);
      expect(await eventually(async () => (await readiness(server)) === 503)).toBe(true);
      expect(await ready(server)).toBe(true);

      await Bun.sleep(LISTING_LAG_MS);
      expect(await connections(vhost)).toHaveLength(1);
      const client = await server.context.subscribe(SUBSCRIPTION, { admin: true });
      try {
        expect(await publish(server, "after the close")).toBe(true);
        const data = await client.nextData<{ events_orders: { message: string } }>();
        expect(data.events_orders.message).toBe("after the close");
      } finally {
        client.close();
      }
    },
    DEADLINE_MS * 3,
  );

  it(
    "is unavailable while the broker is unreachable, and recovers with one connection",
    async () => {
      const vhost = await createVhost();
      proxy = await createTcpProxy({ host: RABBITMQ.host, port: RABBITMQ.port });
      const server = await boot(queueConfig(vhost, {}, proxy.port));
      expect(await ready(server)).toBe(true);

      await proxy.down();
      expect(await eventually(async () => (await readiness(server)) === 503)).toBe(true);
      await proxy.up();

      expect(await ready(server)).toBe(true);
      await Bun.sleep(LISTING_LAG_MS);
      expect(await connections(vhost)).toHaveLength(1);
    },
    DEADLINE_MS * 3,
  );

  it("boots while the broker is unreachable, and connects once it answers", async () => {
    const vhost = await createVhost();
    proxy = await createTcpProxy({ host: RABBITMQ.host, port: RABBITMQ.port });
    await proxy.down();

    const server = await boot(queueConfig(vhost, {}, proxy.port));
    expect(await readiness(server)).toBe(503);
    await proxy.up();

    expect(await ready(server)).toBe(true);
  });

  it("connects once a named queue the broker refused to consume exists", async () => {
    const vhost = await createVhost();
    const server = await boot(
      queueConfig(vhost, {
        autoSetup: false,
        publishers: {},
        subscribers: { orders: { topic: "orders", queue: "orders" } },
      }),
    );
    expect(await readiness(server)).toBe(503);

    await api("PUT", `/queues/${vhost}/orders`, { durable: true });

    expect(await ready(server)).toBe(true);
  });

  it("is refused a generated queue that is neither exclusive nor durable", async () => {
    const vhost = await createVhost();
    const server = await boot(
      queueConfig(vhost, { subscribers: { orders: { topic: "orders", exclusive: false } } }),
    );

    // RabbitMQ 4 answers 541 and closes the connection; each retry gets the same.
    await Bun.sleep(3_000);
    expect(await readiness(server)).toBe(503);
    expect(await queuesOn(vhost)).toEqual([]);
  });

  it("accepts a generated non-exclusive queue that is durable", async () => {
    const vhost = await createVhost();
    const server = await boot(
      queueConfig(vhost, {
        subscribers: { orders: { topic: "orders", exclusive: false, durable: true } },
      }),
    );

    expect(await ready(server)).toBe(true);
  });

  it(
    "leaves no connection behind at shutdown",
    async () => {
      const vhost = await createVhost();
      const server = await boot(queueConfig(vhost));
      expect(await ready(server)).toBe(true);
      expect(await eventually(async () => (await connections(vhost)).length === 1)).toBe(true);

      expect(await server.shutdown()).toBe(true);

      expect(await eventually(async () => (await connections(vhost)).length === 0)).toBe(true);
      // A reconnect would open 1 s after the close.
      await Bun.sleep(1_000 + LISTING_LAG_MS);
      expect(await connections(vhost)).toEqual([]);
    },
    DEADLINE_MS * 3,
  );

  it(
    "keeps serving when a handler outlives its channel, and gets the message again",
    async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on("unhandledRejection", onRejection);
      try {
        const vhost = await createVhost();
        const calls: unknown[] = [];
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const server = await boot(
          queueConfig(vhost, {
            subscribers: {
              orders: {
                topic: "orders",
                queue: "orders",
                durable: true,
                handler: async (message) => {
                  calls.push(message);
                  await released;
                },
              },
            },
          }),
        );
        expect(await ready(server)).toBe(true);
        expect(await eventually(async () => (await connections(vhost)).length === 1)).toBe(true);
        const [connection] = await connections(vhost);

        expect(await publish(server, "slow")).toBe(true);
        expect(await eventually(() => calls.length === 1)).toBe(true);
        await api("DELETE", `/connections/${encodeURIComponent(connection!.name)}`);
        expect(await eventually(async () => (await readiness(server)) === 503)).toBe(true);
        release();

        // Never acknowledged, the message goes back on the queue for the new connection.
        expect(await eventually(() => calls.length === 2)).toBe(true);
        expect(rejections).toEqual([]);
        expect(await readiness(server)).toBe(200);
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    },
    DEADLINE_MS * 3,
  );

  it(
    "publishes again once a missing exchange exists",
    async () => {
      const vhost = await createVhost();
      const server = await boot(queueConfig(vhost, { autoSetup: false, subscribers: {} }));
      expect(await ready(server)).toBe(true);

      // The broker answers 404 and closes the channel.
      await publish(server, "lost");
      await api("PUT", `/exchanges/${vhost}/orders`, { type: "topic", durable: true });
      await api("PUT", `/queues/${vhost}/probe`, { durable: true });
      await api("POST", `/bindings/${vhost}/e/orders/q/probe`, { routing_key: "#" });

      const delivered = await eventually(async () => {
        await publish(server, "found");
        return (await takeMessages(vhost, "probe")).some((message) => message.payload === "found");
      });
      expect(delivered).toBe(true);
    },
    DEADLINE_MS * 2,
  );

  it(
    "consumes again after the broker deletes the subscriber's queue",
    async () => {
      const vhost = await createVhost();
      const server = await boot(
        queueConfig(vhost, {
          subscribers: { orders: { topic: "orders", queue: "orders", durable: true } },
        }),
      );
      expect(await ready(server)).toBe(true);
      const client = await server.context.subscribe(SUBSCRIPTION, { admin: true });
      try {
        await api("DELETE", `/queues/${vhost}/orders`);

        // Unroutable until the queue is declared again.
        const received = await eventually(async () => {
          await publish(server, "after the delete");
          return client.nextData(500).then(
            () => true,
            () => false,
          );
        });
        expect(received).toBe(true);
      } finally {
        client.close();
      }
    },
    DEADLINE_MS * 2,
  );

  it(
    "runs a failing handler twice for one message, then drops it",
    async () => {
      const vhost = await createVhost();
      const calls: unknown[] = [];
      const server = await boot(
        queueConfig(vhost, {
          subscribers: {
            orders: {
              topic: "orders",
              queue: "orders",
              durable: true,
              handler: (message) => {
                calls.push(message);
                throw new Error("poison");
              },
            },
          },
        }),
      );
      expect(await ready(server)).toBe(true);

      expect(await publish(server, "poison")).toBe(true);
      expect(await eventually(() => calls.length >= 2)).toBe(true);
      await Bun.sleep(1_000);

      expect(calls).toEqual(["poison", "poison"]);
      expect(await takeMessages(vhost, "orders")).toEqual([]);
    },
    DEADLINE_MS * 2,
  );

  it(
    "runs a subscriber's handler one message at a time",
    async () => {
      let running = 0;
      let peak = 0;
      let handled = 0;
      const server = await boot(
        queueConfig(await createVhost(), {
          subscribers: {
            orders: {
              topic: "orders",
              handler: async () => {
                running++;
                peak = Math.max(peak, running);
                await Bun.sleep(100);
                running--;
                handled++;
              },
            },
          },
        }),
      );
      expect(await ready(server)).toBe(true);

      for (let n = 0; n < 5; n++) expect(await publish(server, `m-${n}`)).toBe(true);
      expect(await eventually(() => handled === 5)).toBe(true);

      expect(peak).toBe(1);
    },
    DEADLINE_MS * 2,
  );

  it("sends a client that joins a subscription only the messages after it joined", async () => {
    const server = await boot(queueConfig(await createVhost()));
    expect(await ready(server)).toBe(true);
    const first = await server.context.subscribe(SUBSCRIPTION, { admin: true });
    try {
      expect(await publish(server, "m1")).toBe(true);
      expect(
        (await first.nextData<{ events_orders: { message: string } }>()).events_orders.message,
      ).toBe("m1");

      const second = await server.context.subscribe(SUBSCRIPTION, { admin: true });
      try {
        expect(await publish(server, "m2")).toBe(true);

        const data = await second.nextData<{ events_orders: { message: string } }>();
        expect(data.events_orders.message).toBe("m2");
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it("answers false for a message published to a missing exchange", async () => {
    const server = await boot(
      queueConfig(await createVhost(), { autoSetup: false, subscribers: {} }),
    );
    expect(await ready(server)).toBe(true);

    expect(await publish(server, "nowhere")).toBe(false);
  });

  it(
    "opens no connection and serves no publisher for a disabled queue",
    async () => {
      const vhost = await createVhost();
      const server = await boot(queueConfig(vhost, { enabled: false }));

      const published = await server.context.gql<{ events_orderCreated?: boolean }>(
        PUBLISH,
        { data: "m" },
        { admin: true },
      );
      // Not in the schema, so the document fails validation.
      expect(published.data?.events_orderCreated).toBeUndefined();
      expect(published.errors).toHaveLength(1);
      expect(await readiness(server)).toBe(200);
      await Bun.sleep(LISTING_LAG_MS);
      expect(await connections(vhost)).toEqual([]);
    },
    DEADLINE_MS * 2,
  );

  it(
    "declares the exchange of a topic only subscribers use",
    async () => {
      const vhost = await createVhost();
      const server = await boot(
        queueConfig(vhost, { publishers: {}, subscribers: { orders: { topic: "orders" } } }),
      );
      expect(await ready(server)).toBe(true);

      const client = await server.context.subscribe(SUBSCRIPTION, { admin: true });
      try {
        // Published by another service, not through this server.
        await api("POST", `/exchanges/${vhost}/orders/publish`, {
          properties: {},
          routing_key: "order.created",
          payload: "from elsewhere",
          payload_encoding: "string",
        });

        const data = await client.nextData<{ events_orders: { message: string } }>();
        expect(data.events_orders.message).toBe("from elsewhere");
      } finally {
        client.close();
      }
    },
    DEADLINE_MS * 2,
  );
});

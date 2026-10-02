import { afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { QueueConfig } from "../../config";
import type { StartedServer } from "./harness";

import { KAFKA_BROKER } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";

/**
 * Topics and consumer groups outlive a test on the shared broker, so every test
 * names its own. The broker creates a topic the first time a client asks for it.
 */

const ENGINE = "sqlite" as const;
const DEADLINE_MS = 30_000;

const SUBSCRIPTION = "subscription { events_orders { id message } }";
const PUBLISH = "mutation ($data: String!) { events_orderCreated(data: $data) }";

const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

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
  topic: string,
  group: string,
  connection: string = KAFKA_BROKER,
): QueueConfig => ({
  type: "kafka",
  name: "events",
  connection,
  publishers: { orderCreated: { topic } },
  subscribers: { orders: { topic, group } },
  topics: { [topic]: {} },
});

describe.skipIf(!integrationEnabled)("kafka queues", () => {
  let started: StartedServer | undefined;

  const boot = async (queue: QueueConfig) => {
    started = await startServer({ engine: ENGINE, skipSeed: true, config: { queues: [queue] } });
    return started;
  };

  const readiness = async (server: StartedServer) =>
    (await Bun.fetch(`http://localhost:${server.context.server.port}/health/ready`)).status;

  const ready = (server: StartedServer, deadlineMs?: number) =>
    eventually(async () => (await readiness(server)) === 200, deadlineMs);

  const publish = async (server: StartedServer, data: string) =>
    (await server.context.gql<{ events_orderCreated: boolean }>(PUBLISH, { data }, { admin: true }))
      .data?.events_orderCreated;

  beforeAll(async () => {
    await seedEngine(ENGINE);
  });

  afterEach(async () => {
    await started?.stop();
    started = undefined;
  });

  it(
    "delivers a published message to a subscription",
    async () => {
      const server = await boot(queueConfig(unique("orders"), unique("group")));
      expect(await ready(server)).toBe(true);

      const client = await server.context.subscribe(SUBSCRIPTION, { admin: true });
      try {
        // A new group starts at the end of the topic, wherever that is at its
        // first fetch, so publish until one message is past it.
        let received = false;
        const message = client.nextData<{ events_orders: { message: string } }>(DEADLINE_MS);
        void message.then(() => (received = true));
        for (let n = 0; !received && n < 40; n++) {
          expect(await publish(server, `m-${n}`)).toBe(true);
          await Bun.sleep(250);
        }

        expect((await message).events_orders.message).toMatch(/^m-\d+$/);
      } finally {
        client.close();
      }
    },
    DEADLINE_MS * 2,
  );

  it("boots while the broker is unreachable, and reports it unavailable", async () => {
    const server = await boot(queueConfig(unique("orders"), unique("group"), "127.0.0.1:1"));

    expect(await readiness(server)).toBe(503);
  });

  it("lists its publishers, and answers a publish, while the broker is unreachable", async () => {
    const consolePath = "/_console";
    const server = await startServer({
      engine: ENGINE,
      skipSeed: true,
      config: { queues: [queueConfig(unique("orders"), unique("group"), "127.0.0.1:1")] },
      env: {
        console: {
          enabled: true,
          endpoint: consolePath,
          sessionExpiresIn: "1h",
          readSecrets: [],
          writeSecrets: ["console-write-secret"],
        },
      },
    });
    started = server;
    const url = (path: string) =>
      `http://localhost:${server.context.server.port}${consolePath}/api/${path}`;
    const login = await Bun.fetch(url("login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "console-write-secret" }),
    });
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;

    const status = (await (await Bun.fetch(url("status"), { headers: { cookie } })).json()) as {
      publishers: string[];
    };
    const sent = await Bun.fetch(url("queues/publish"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ publisher: "events_orderCreated", message: "m" }),
    });

    expect(status.publishers).toEqual(["events_orderCreated"]);
    expect(await sent.json()).toEqual({ ok: false });
  });

  it(
    "runs a subscriber's handler once per message",
    async () => {
      const topic = unique("orders");
      const calls: unknown[] = [];
      const queue = queueConfig(topic, unique("group"));
      const server = await boot({
        ...queue,
        subscribers: {
          orders: {
            topic,
            group: unique("group"),
            handler: (message) => {
              calls.push(message);
            },
          },
        },
      } as QueueConfig);
      expect(await ready(server)).toBe(true);

      // A new group starts at the end of the topic: publish until one message is past it.
      for (let n = 0; calls.length === 0 && n < 40; n++) {
        expect(await publish(server, JSON.stringify({ n }))).toBe(true);
        await Bun.sleep(250);
      }
      expect(await publish(server, JSON.stringify({ n: "last" }))).toBe(true);
      expect(
        await eventually(() => calls.some((call) => (call as { n: unknown }).n === "last")),
      ).toBe(true);
      await Bun.sleep(500);

      expect(calls.filter((call) => (call as { n: unknown }).n === "last")).toHaveLength(1);
      expect(new Set(calls.map((call) => JSON.stringify(call))).size).toBe(calls.length);
    },
    DEADLINE_MS * 2,
  );

  it(
    "leaves the consumer group at shutdown, so the next server joins at once",
    async () => {
      const topic = unique("orders");
      const group = unique("group");
      const first = await boot(queueConfig(topic, group));
      expect(await ready(first)).toBe(true);

      expect(await first.shutdown()).toBe(true);
      await first.stop();
      started = undefined;

      // A member that never left holds the group for its 30 s session timeout.
      const second = await boot(queueConfig(topic, group));
      expect(await ready(second, 10_000)).toBe(true);
    },
    DEADLINE_MS * 2,
  );
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { QueueConfig } from "../../config";
import type { StartedServer, SubscriptionClient } from "./harness";

import { KAFKA_BROKER, RABBITMQ } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { seedEngine } from "./seed";

/**
 * One server with a RabbitMQ queue and a Kafka queue: each broker's adapter
 * starts with its own queue only, a publish reaches the queue that owns the
 * publisher, and shutdown closes both.
 */

const ENGINE = "sqlite" as const;
const DEADLINE_MS = 30_000;

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

const messages = (client: SubscriptionClient, field: string) =>
  client.received
    .filter((message) => message.type === "next")
    .map(
      (message) =>
        (message.payload as { data: Record<string, { message: string }> }).data[field]?.message,
    );

describe.skipIf(!integrationEnabled)("rabbitmq and kafka queues in one server", () => {
  let started: StartedServer | undefined;
  const vhost = `graphoria-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await seedEngine(ENGINE);
    await api("PUT", `/vhosts/${vhost}`);
    await api("PUT", `/permissions/${vhost}/${RABBITMQ.username}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
  });

  afterEach(async () => {
    await started?.stop();
    started = undefined;
  });

  afterAll(async () => {
    await api("DELETE", `/vhosts/${vhost}`);
  });

  it(
    "starts both, routes each publish to its own broker, and closes both at shutdown",
    async () => {
      const topic = `orders-${crypto.randomUUID()}`;
      const queues: QueueConfig[] = [
        {
          type: "rabbitmq",
          name: "events",
          connection: {
            hostname: RABBITMQ.host,
            port: RABBITMQ.port,
            username: RABBITMQ.username,
            password: RABBITMQ.password,
            vhost,
          },
          publishers: { orderCreated: { topic: "orders", routingKey: "order.created" } },
          subscribers: { orders: { topic: "orders", pattern: "order.*" } },
          topics: { orders: {} },
        },
        {
          type: "kafka",
          name: "stream",
          connection: KAFKA_BROKER,
          publishers: { orderCreated: { topic } },
          subscribers: { orders: { topic, group: `group-${crypto.randomUUID()}` } },
          topics: { [topic]: {} },
        },
      ];
      const server = await startServer({ engine: ENGINE, skipSeed: true, config: { queues } });
      started = server;
      const ready = `http://localhost:${server.context.server.port}/health/ready`;
      const publish = async (field: string, data: string) =>
        (
          await server.context.gql<Record<string, boolean>>(
            `mutation ($data: String!) { ${field}(data: $data) }`,
            { data },
            { admin: true },
          )
        ).data?.[field];

      expect(await eventually(async () => (await Bun.fetch(ready)).status === 200)).toBe(true);
      const { checks } = (await (await Bun.fetch(ready)).json()) as {
        checks: { kind: string; name?: string; ok: boolean }[];
      };
      expect(checks.filter((check) => ["rabbitmq", "kafka"].includes(check.kind))).toEqual([
        { kind: "rabbitmq", name: "events", ok: true },
        { kind: "kafka", name: "stream", ok: true },
      ]);

      const admin = { admin: true };
      const rabbitmq = await server.context.subscribe(
        "subscription { events_orders { message } }",
        admin,
      );
      const kafka = await server.context.subscribe(
        "subscription { stream_orders { message } }",
        admin,
      );
      try {
        expect(await publish("events_orderCreated", "to-rabbitmq")).toBe(true);
        expect(
          await eventually(() => messages(rabbitmq, "events_orders").includes("to-rabbitmq")),
        ).toBe(true);

        // A new group starts at the end of the topic: publish until one message is past it.
        for (let n = 0; messages(kafka, "stream_orders").length === 0 && n < 40; n++) {
          expect(await publish("stream_orderCreated", `to-kafka-${n}`)).toBe(true);
          await Bun.sleep(250);
        }
        expect(await eventually(() => messages(kafka, "stream_orders").length > 0)).toBe(true);

        expect(messages(rabbitmq, "events_orders")).toEqual(["to-rabbitmq"]);
        expect(messages(kafka, "stream_orders").every((m) => m?.startsWith("to-kafka-"))).toBe(
          true,
        );
      } finally {
        rabbitmq.close();
        kafka.close();
      }

      expect(await server.shutdown()).toBe(true);

      const { queueManager } = await import("../../singletons/queues");
      expect(queueManager.connections()).toEqual([
        { type: "rabbitmq", name: "events", connected: false },
        { type: "kafka", name: "stream", connected: false },
      ]);
      expect(
        await eventually(
          async () =>
            ((await (await api("GET", `/vhosts/${vhost}/connections`)).json()) as unknown[])
              .length === 0,
        ),
      ).toBe(true);
    },
    DEADLINE_MS * 3,
  );
});

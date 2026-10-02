import { describe, expect, it } from "bun:test";

import { QueueConfigZod } from "./queue";

describe("KafkaConnectionZod clientId", () => {
  it("accepts and preserves a user-provided clientId", () => {
    const parsed = QueueConfigZod.parse({
      type: "kafka",
      name: "events",
      connection: { brokers: ["localhost:9092"], clientId: "my-app" },
      publishers: { userEvent: { topic: "user-events" } },
    });

    if (parsed.type !== "kafka") throw new Error("expected kafka config");
    expect(typeof parsed.connection).not.toBe("string");
    expect((parsed.connection as { clientId?: string }).clientId).toBe("my-app");
  });

  it("leaves clientId undefined when omitted", () => {
    const parsed = QueueConfigZod.parse({
      type: "kafka",
      name: "events",
      connection: { brokers: ["localhost:9092"] },
    });

    if (parsed.type !== "kafka") throw new Error("expected kafka config");
    expect((parsed.connection as { clientId?: string }).clientId).toBeUndefined();
  });
});

describe("KafkaConnectionZod sasl.mechanism", () => {
  const parseSasl = (sasl: Record<string, unknown>) => {
    const parsed = QueueConfigZod.parse({
      type: "kafka",
      name: "events",
      connection: { brokers: ["localhost:9092"], sasl },
    });
    if (parsed.type !== "kafka") throw new Error("expected kafka config");
    return (parsed.connection as { sasl?: { mechanism?: string } }).sasl;
  };

  it("defaults mechanism to plain when omitted", () => {
    expect(parseSasl({ username: "u", password: "p" })?.mechanism).toBe("plain");
  });

  it("preserves an explicit scram mechanism", () => {
    expect(parseSasl({ username: "u", password: "p", mechanism: "scram-sha-256" })?.mechanism).toBe(
      "scram-sha-256",
    );
  });

  it("rejects an unknown mechanism", () => {
    expect(() => parseSasl({ username: "u", password: "p", mechanism: "gssapi" })).toThrow();
  });
});

describe("subscriber exclusive", () => {
  const parse = (subscriber: Record<string, unknown>) => {
    const parsed = QueueConfigZod.parse({
      type: "rabbitmq",
      name: "events",
      connection: { hostname: "x", port: 5672 },
      subscribers: { s1: subscriber },
    });
    if (parsed.type !== "rabbitmq") throw new Error("expected rabbitmq config");
    return parsed.queues[0]!.queueOptions;
  };

  it("carries an explicit exclusive through the transform", () => {
    expect(parse({ topic: "t", exclusive: true })?.exclusive).toBe(true);
  });

  it("leaves exclusive undefined when omitted", () => {
    expect(parse({ topic: "t" })?.exclusive).toBeUndefined();
  });
});

describe("exchanges", () => {
  it("declares the topic only subscribers use, with its own settings", () => {
    const parsed = QueueConfigZod.parse({
      type: "rabbitmq",
      name: "events",
      connection: { hostname: "x", port: 5672 },
      publishers: { placed: { topic: "orders" } },
      subscribers: { restock: { topic: "inventory" } },
      topics: { orders: {}, inventory: { type: "fanout" } },
    });

    expect(
      parsed.exchanges.map(({ name, type, publishers }) => ({
        name,
        type,
        publishers: publishers.map((publisher) => publisher.name),
      })),
    ).toEqual([
      { name: "orders", type: "topic", publishers: ["placed"] },
      { name: "inventory", type: "fanout", publishers: [] },
    ]);
  });

  it("declares a topic both sides use once", () => {
    const parsed = QueueConfigZod.parse({
      type: "rabbitmq",
      name: "events",
      connection: { hostname: "x", port: 5672 },
      publishers: { placed: { topic: "orders" } },
      subscribers: { audit: { topic: "orders" } },
      topics: { orders: {} },
    });

    expect(parsed.exchanges.map((exchange) => exchange.name)).toEqual(["orders"]);
  });
});

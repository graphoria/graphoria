import { describe, expect, it } from "bun:test";

import { queue } from "./queueHelper";

describe("queue helper", () => {
  it("rabbitmq() adds the type discriminator and preserves config", () => {
    const result = queue.rabbitmq({
      name: "events",
      connection: "amqp://localhost",
      publishers: { orderCreated: { topic: "orders", routingKey: "order.created" } },
    });

    expect(result.type).toBe("rabbitmq");
    expect(result.name).toBe("events");
    expect(result.connection).toBe("amqp://localhost");
    expect(result.publishers?.orderCreated?.topic).toBe("orders");
  });

  it("kafka() adds the type discriminator and accepts a clientId", () => {
    const result = queue.kafka({
      name: "events",
      connection: { brokers: ["localhost:9092"], clientId: "my-app" },
    });

    expect(result.type).toBe("kafka");
    expect(result.connection).toEqual({ brokers: ["localhost:9092"], clientId: "my-app" });
  });
});

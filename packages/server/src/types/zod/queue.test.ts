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

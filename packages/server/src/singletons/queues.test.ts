import { describe, expect, it } from "bun:test";

import type { QueueConfig } from "../types/zod/queue";

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

const queues = await import("./queues");

describe("instantiateQueues", () => {
  it("reaches the RabbitMQ connections from the combined cleanup", async () => {
    let cleanups = 0;

    await queues.instantiateQueues([{ type: "rabbitmq", name: "q" } as QueueConfig], {
      startRabbitMQ: async () => ({
        managers: [],
        publisherMap: () => ({}),
        sendMessage: () => true,
        cleanup: async () => {
          cleanups++;
        },
      }),
    });
    await queues.queueManager!.cleanup!();

    expect(cleanups).toBe(1);
    queues.setQueueManager(undefined);
  });
});

import { describe, expect, it } from "bun:test";

import type { ServerWebSocket } from "bun";
import type { SubscriptionContext } from "../types";

import { createQueryEventEmitter } from "../../utils/event-emitter";
import { createQueueSubscriptionStrategy } from "./queue";

const socket = () => {
  const sent: unknown[] = [];
  const ws = {
    send: (data: string) => sent.push(JSON.parse(data)),
  } as unknown as ServerWebSocket<unknown>;
  return { ws, sent };
};

const contextFor = (
  eventEmitter: ReturnType<typeof createQueryEventEmitter>,
  ws: ServerWebSocket<unknown>,
  subscriptionId: string,
) =>
  ({
    ws,
    subscriptionId,
    eventEmitter,
    field: { name: "events_orders", selections: [{ name: "message" }] },
  }) as unknown as SubscriptionContext;

describe("queue subscription strategy", () => {
  it("sends a client that joins a group only the messages after it joined", async () => {
    const strategy = createQueueSubscriptionStrategy();
    const eventEmitter = createQueryEventEmitter();
    const first = socket();
    const second = socket();

    await strategy.subscribe(contextFor(eventEmitter, first.ws, "1"));
    eventEmitter.sendDataUpdate("events_orders", { data: { message: "m1", id: "1" } });
    await strategy.subscribe(contextFor(eventEmitter, second.ws, "2"));

    expect(second.sent).toEqual([]);

    eventEmitter.sendDataUpdate("events_orders", { data: { message: "m2", id: "2" } });

    expect(second.sent).toEqual([
      { id: "2", type: "next", payload: { data: { events_orders: { message: "m2" } } } },
    ]);
    expect(first.sent).toEqual([
      { id: "1", type: "next", payload: { data: { events_orders: { message: "m1" } } } },
      { id: "1", type: "next", payload: { data: { events_orders: { message: "m2" } } } },
    ]);
  });
});

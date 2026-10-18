import { describe, expect, it } from "bun:test";

import type { ServerWebSocket } from "bun";
import type { SelectionAnalysis } from "../../analyzeQuery/types";
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
  selections: SelectionAnalysis[] = [{ name: "message" }],
) =>
  ({
    ws,
    subscriptionId,
    eventEmitter,
    field: { name: "events_orders", selections },
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

  it("names the message's type when the subscription selects __typename", async () => {
    const strategy = createQueueSubscriptionStrategy();
    const eventEmitter = createQueryEventEmitter();
    const client = socket();

    await strategy.subscribe(
      contextFor(eventEmitter, client.ws, "1", [
        { name: "__typename", typeName: "QueueMutationResponse" },
        { name: "message" },
      ]),
    );
    eventEmitter.sendDataUpdate("events_orders", { data: { message: "m1", id: "1" } });

    expect(client.sent).toEqual([
      {
        id: "1",
        type: "next",
        payload: {
          data: { events_orders: { __typename: "QueueMutationResponse", message: "m1" } },
        },
      },
    ]);
  });
});

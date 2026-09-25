import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * The upgrade needs no credential, so a frame the handler cannot process must
 * cost the client its socket or its operation, never the process.
 */

const ENGINE = "pg" as const;

describe.skipIf(!integrationEnabled)("websocket frames", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer({ engine: ENGINE });
  });

  afterAll(async () => {
    await started?.stop();
  });

  const open = async () => {
    const socket = new WebSocket(`ws://localhost:${started.context.server.port}/graphql`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("websocket failed to open"));
    });
    return socket;
  };

  const nextMessage = (socket: WebSocket) =>
    new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
        once: true,
      }),
    );

  const closeCode = (socket: WebSocket) =>
    new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );

  it("closes a socket that sends a frame that is not JSON, and keeps serving the others", async () => {
    const bystander = await open();
    const ack = nextMessage(bystander);
    bystander.send(JSON.stringify({ type: "connection_init", payload: {} }));
    expect(await ack).toEqual({ type: "connection_ack" });

    const offender = await open();
    const closed = closeCode(offender);
    offender.send("not json");
    expect(await closed).toBe(4400);

    const pong = nextMessage(bystander);
    bystander.send(JSON.stringify({ type: "ping" }));
    expect(await pong).toEqual({ type: "pong" });
    bystander.close();

    const live = await Bun.fetch(`http://localhost:${started.context.server.port}/health/live`);
    expect(live.status).toBe(200);
  });

  it("answers an error for a subscribe that carries a query document", async () => {
    const client = await started.context.subscribe("query { __typename }");
    try {
      expect(await client.next()).toEqual({
        id: "1",
        type: "error",
        payload: [{ message: "Internal server error" }],
      });
    } finally {
      client.close();
    }
  });
});

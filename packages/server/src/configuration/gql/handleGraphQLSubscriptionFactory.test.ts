import { beforeAll, describe, expect, it, mock } from "bun:test";

import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { AnalyzedConfiguration } from "../../configuration";

// `singletons/env` parses process.env at module load. Set required vars before
// any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

let websocketHandlerFactory: (roles: AnalyzedConfiguration["roles"]) => WebSocketHandler<unknown>;
let anonymousRole: string;

beforeAll(async () => {
  ({ websocketHandlerFactory } = await import("./handleGraphQLSubscriptionFactory"));
  anonymousRole = (await import("../../singletons/env")).env.anonymousRole;
});

const fakeSocket = () => {
  const socket = {
    send: mock((_message: string) => 0),
    close: mock((_code?: number, _reason?: string) => {}),
    remoteAddress: "127.0.0.1",
  };
  return { socket, ws: socket as unknown as ServerWebSocket<unknown> };
};

const sent = (socket: ReturnType<typeof fakeSocket>["socket"]) =>
  socket.send.mock.calls.map(([message]) => JSON.parse(message));

describe("websocketHandlerFactory message", () => {
  it.each([
    ["a frame that is not JSON", "not json"],
    ["a JSON null frame", "null"],
    ["a binary frame that is not JSON", Buffer.from("not json")],
  ])("closes with 4400 on %s", async (_label, frame) => {
    const handler = websocketHandlerFactory({});
    const { socket, ws } = fakeSocket();

    await handler.message(ws, frame);

    expect(socket.close).toHaveBeenCalledWith(4400, "Invalid message");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("closes with 4401 on a subscribe before connection_init", async () => {
    const handler = websocketHandlerFactory({});
    const { socket, ws } = fakeSocket();

    await handler.message(
      ws,
      JSON.stringify({ id: "1", type: "subscribe", payload: { query: "subscription { x }" } }),
    );

    expect(socket.close).toHaveBeenCalledWith(4401, "Unauthorized");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("answers an error for the id and keeps the socket open when a subscribe fails", async () => {
    const roles = {
      [anonymousRole]: {
        handlers: {
          gql: {
            hasErrors: () => {
              throw new TypeError("undefined is not an object (evaluating 'body.length')");
            },
          },
        },
      },
    } as unknown as AnalyzedConfiguration["roles"];
    const handler = websocketHandlerFactory(roles);
    const { socket, ws } = fakeSocket();

    await handler.message(ws, JSON.stringify({ type: "connection_init", payload: {} }));
    await handler.message(ws, JSON.stringify({ id: "1", type: "subscribe", payload: {} }));

    expect(sent(socket)).toEqual([
      { type: "connection_ack" },
      { id: "1", type: "error", payload: [{ message: "Internal server error" }] },
    ]);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes with 4500 when connection_init fails", async () => {
    const handler = websocketHandlerFactory({});
    const { socket, ws } = fakeSocket();

    await handler.message(
      ws,
      JSON.stringify({ type: "connection_init", payload: { Authorization: 1 } }),
    );

    expect(socket.close).toHaveBeenCalledWith(4500, "Internal server error");
    expect(socket.send).not.toHaveBeenCalled();
  });
});

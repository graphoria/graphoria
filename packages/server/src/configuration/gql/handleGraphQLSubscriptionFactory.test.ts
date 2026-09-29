import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { AnalyzedConfiguration } from "../../configuration";
import type { AuditEvent } from "../../logging/audit";

// `singletons/env` parses process.env at module load. Set required vars before
// any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

let websocketHandlerFactory: (
  roles: AnalyzedConfiguration["roles"],
  adminSecretHeader: string,
) => {
  handler: WebSocketHandler<unknown>;
  closeAll: (code: number, reason: string) => void;
};
let anonymousRole: string;
let adminSecret: string;
// oxlint-disable-next-line typescript/no-explicit-any
let setAuditLog: any;

const HEADER = "x-admin-secret";

beforeAll(async () => {
  ({ websocketHandlerFactory } = await import("./handleGraphQLSubscriptionFactory"));
  ({ setAuditLog } = await import("../../logging/audit"));
  const { env } = await import("../../singletons/env");
  anonymousRole = env.anonymousRole;
  adminSecret = env.admin.secrets[0]!;
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
    const { handler } = websocketHandlerFactory({}, HEADER);
    const { socket, ws } = fakeSocket();

    await handler.message(ws, frame);

    expect(socket.close).toHaveBeenCalledWith(4400, "Invalid message");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("closes with 4401 on a subscribe before connection_init", async () => {
    const { handler } = websocketHandlerFactory({}, HEADER);
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
    const { handler } = websocketHandlerFactory(roles, HEADER);
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
    const { handler } = websocketHandlerFactory({}, HEADER);
    const { socket, ws } = fakeSocket();

    await handler.message(
      ws,
      JSON.stringify({ type: "connection_init", payload: { Authorization: 1 } }),
    );

    expect(socket.close).toHaveBeenCalledWith(4500, "Internal server error");
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe("websocketHandlerFactory connection_init", () => {
  let records: AuditEvent[];

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event: AuditEvent) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  const connect = async (adminSecretHeader: string, headers: unknown) => {
    const { handler } = websocketHandlerFactory({}, adminSecretHeader);
    const { socket, ws } = fakeSocket();

    await handler.message(ws, JSON.stringify({ type: "connection_init", payload: { headers } }));

    return sent(socket);
  };

  it.each([
    ["x-graphoria-key", "x-graphoria-key"],
    ["x-graphoria-key", "X-Graphoria-Key"],
    ["X-Graphoria-Key", "x-graphoria-key"],
  ])("takes the admin secret under the header %s, sent as %s", async (header, key) => {
    expect(await connect(header, { [key]: adminSecret })).toEqual([{ type: "connection_ack" }]);
    expect(records).toEqual([
      {
        action: "admin_secret.used",
        actor: { type: "admin_secret", ip: "127.0.0.1" },
        target: { kind: "websocket" },
      },
    ]);
  });

  it("ignores x-admin-secret once the header is renamed", async () => {
    expect(await connect("x-graphoria-key", { "x-admin-secret": adminSecret })).toEqual([
      { type: "connection_ack" },
    ]);
    expect(records).toEqual([]);
  });

  it.each([
    ["null", null],
    ["a string", "x-admin-secret"],
    ["an array", ["x-admin-secret"]],
  ])("connects anonymously when headers is %s", async (_label, headers) => {
    expect(await connect(HEADER, headers)).toEqual([{ type: "connection_ack" }]);
    expect(records).toEqual([]);
  });
});

describe("websocketHandlerFactory closeAll", () => {
  it("closes every socket still open with the given code", () => {
    const { handler, closeAll } = websocketHandlerFactory({}, HEADER);
    const first = fakeSocket();
    const second = fakeSocket();
    const gone = fakeSocket();
    for (const { ws } of [first, second, gone]) handler.open!(ws);
    handler.close!(gone.ws, 1000, "");

    closeAll(1001, "server shutting down");

    expect(first.socket.close).toHaveBeenCalledWith(1001, "server shutting down");
    expect(second.socket.close).toHaveBeenCalledWith(1001, "server shutting down");
    expect(gone.socket.close).not.toHaveBeenCalled();
  });
});

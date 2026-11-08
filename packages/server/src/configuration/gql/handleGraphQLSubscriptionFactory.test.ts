import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildSchema } from "graphql";

import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { AnalyzedConfiguration } from "../../configuration";
import type { AuditEvent } from "../../logging/audit";

import { EntitySource } from "../../types/resolver";

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
// oxlint-disable-next-line typescript/no-explicit-any
let queryEventEmitter: any;

const HEADER = "x-admin-secret";

beforeAll(async () => {
  ({ websocketHandlerFactory, queryEventEmitter } =
    await import("./handleGraphQLSubscriptionFactory"));
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

    await handler.message!(ws, frame);

    expect(socket.close).toHaveBeenCalledWith(4400, "Invalid message");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("closes with 4401 on a subscribe before connection_init", async () => {
    const { handler } = websocketHandlerFactory({}, HEADER);
    const { socket, ws } = fakeSocket();

    await handler.message!(
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

    await handler.message!(ws, JSON.stringify({ type: "connection_init", payload: {} }));
    await handler.message!(ws, JSON.stringify({ id: "1", type: "subscribe", payload: {} }));

    expect(sent(socket)).toEqual([
      { type: "connection_ack" },
      { id: "1", type: "error", payload: [{ message: "Internal server error" }] },
    ]);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes with 4500 when connection_init fails", async () => {
    const { handler } = websocketHandlerFactory({}, HEADER);
    const { socket, ws } = fakeSocket();

    await handler.message!(
      ws,
      JSON.stringify({ type: "connection_init", payload: { Authorization: 1 } }),
    );

    expect(socket.close).toHaveBeenCalledWith(4500, "Internal server error");
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe("websocketHandlerFactory subscribe to a queue", () => {
  const schema = buildSchema(`
    type Query { x: Int }
    type Subscription {
      events_spread: Order
      events_inline: Order
      events_root: Order
      events_vars: Order
      events_empty: Order
    }
    type Order { message: String id: ID }
  `);
  const MESSAGE = { message: "m1", id: "1" };

  const start = async () => {
    const { handler } = websocketHandlerFactory(
      {
        [anonymousRole]: {
          schema,
          queriesMap: {},
          getResolverSource: () => EntitySource.QUEUE_SUBSCRIBER,
          handlers: {
            gql: { hasErrors: () => ({ hasErrors: false, validationErrors: [] }) },
          },
        },
      } as unknown as AnalyzedConfiguration["roles"],
      HEADER,
    );
    const { socket, ws } = fakeSocket();
    await handler.message!(ws, JSON.stringify({ type: "connection_init", payload: {} }));

    const subscribe = (id: string, query: string, variables?: Record<string, unknown>) =>
      handler.message!(
        ws,
        JSON.stringify({ id, type: "subscribe", payload: { query, variables } }),
      );

    return { socket, subscribe };
  };

  const payloads = (socket: ReturnType<typeof fakeSocket>["socket"]) =>
    sent(socket)
      .filter((message) => message.type !== "connection_ack")
      .map((message) => message.payload);

  it("answers the fields a fragment selects", async () => {
    const { socket, subscribe } = await start();

    await subscribe("1", "subscription { events_spread { ...O } } fragment O on Order { message }");
    queryEventEmitter.sendDataUpdate("events_spread", { data: MESSAGE });

    expect(payloads(socket)).toEqual([{ data: { events_spread: { message: "m1" } } }]);
  });

  it("leaves out what an inline fragment's directive excludes", async () => {
    const { socket, subscribe } = await start();

    await subscribe("1", "subscription { events_inline { id ... @skip(if: true) { message } } }");
    queryEventEmitter.sendDataUpdate("events_inline", { data: MESSAGE });

    expect(payloads(socket)).toEqual([{ data: { events_inline: { id: "1" } } }]);
  });

  it("subscribes to a field in a root-level fragment", async () => {
    const { socket, subscribe } = await start();

    await subscribe("1", "subscription { ...S } fragment S on Subscription { events_root { id } }");
    queryEventEmitter.sendDataUpdate("events_root", { data: MESSAGE });

    expect(payloads(socket)).toEqual([{ data: { events_root: { id: "1" } } }]);
  });

  it("answers an empty object when every subfield is excluded", async () => {
    const { socket, subscribe } = await start();

    await subscribe("1", "subscription { events_empty { id @skip(if: true) } }");
    queryEventEmitter.sendDataUpdate("events_empty", { data: MESSAGE });

    expect(payloads(socket)).toEqual([{ data: { events_empty: {} } }]);
  });

  it("gives clients whose variables select different fields their own group", async () => {
    const skips = await start();
    const keeps = await start();
    const query = "subscription S($s: Boolean!) { events_vars { message id @skip(if: $s) } }";

    await skips.subscribe("1", query, { s: true });
    await keeps.subscribe("2", query, { s: false });
    queryEventEmitter.sendDataUpdate("events_vars", { data: MESSAGE });

    expect(payloads(skips.socket)).toEqual([{ data: { events_vars: { message: "m1" } } }]);
    expect(payloads(keeps.socket)).toEqual([{ data: { events_vars: MESSAGE } }]);
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

    await handler.message!(ws, JSON.stringify({ type: "connection_init", payload: { headers } }));

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

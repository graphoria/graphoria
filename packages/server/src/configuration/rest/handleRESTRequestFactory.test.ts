import { beforeAll, describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

// oxlint-disable-next-line typescript/no-explicit-any
type Hooks = Record<string, any>;

// oxlint-disable-next-line typescript/no-explicit-any
let handleRESTRequestFactory: any;

beforeAll(async () => {
  ({ handleRESTRequestFactory } = await import("./handleRESTRequestFactory"));
});

const stubGql = () =>
  ({
    handler: async () => ({ data: null }),
    hasErrors: () => ({ hasErrors: false, errors: [] }),
  }) as const;

const stubGqlEntities = () =>
  ({
    typeDefs: "",
    schema: null,
    introspection: null,
  }) as const;

const stubEntities = (
  operationKey: string,
  operation: {
    // oxlint-disable-next-line typescript/no-explicit-any
    handler?: (...args: any[]) => unknown;
    hooks?: Hooks;
    rest?: { path: string; method?: string };
  },
) =>
  ({
    operations: {
      [operationKey]: {
        rest: { path: "/test", method: "GET", ...operation.rest },
        ...operation,
      },
    },
    remoteRESTApis: [],
  }) as const;

const fakeReq = (method = "GET"): BunRequest => ({ method }) as unknown as BunRequest;

describe("handleRESTRequestFactory hook lifecycle (custom handler)", () => {
  it("invokes init then beforeRequest then handler then afterRequest, in order", async () => {
    const callOrder: string[] = [];

    const factory = handleRESTRequestFactory(
      stubEntities("op_a", {
        handler: () => {
          callOrder.push("handler");
          return { ok: true };
        },
        hooks: {
          init: () => {
            callOrder.push("init");
            return { initData: 42 };
          },
          beforeRequest: ({ input }: { input: object }) => {
            callOrder.push("beforeRequest");
            return { ...input, beforeAdded: true };
          },
          afterRequest: ({ output }: { output: object }) => {
            callOrder.push("afterRequest");
            return { ...output, afterAdded: true };
          },
        },
      }),
      stubGqlEntities(),
      stubGql(),
    );

    await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());

    expect(callOrder).toEqual(["init", "beforeRequest", "handler", "afterRequest"]);
  });

  it("caches init across multiple requests (init runs once)", async () => {
    let initCount = 0;
    let handlerCount = 0;

    const factory = handleRESTRequestFactory(
      stubEntities("op_b", {
        handler: () => {
          handlerCount++;
          return { ok: true };
        },
        hooks: {
          init: () => {
            initCount++;
            return { v: initCount };
          },
        },
      }),
      stubGqlEntities(),
      stubGql(),
    );

    await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());
    await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());
    await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());

    expect(initCount).toBe(1);
    expect(handlerCount).toBe(3);
  });

  it("forwards init result as second arg to beforeRequest", async () => {
    let observedInitData: unknown = null;

    const factory = handleRESTRequestFactory(
      stubEntities("op_c", {
        handler: () => ({ ok: true }),
        hooks: {
          init: () => ({ secret: "shh" }),
          beforeRequest: ({ input }: { input: object }, initData: unknown) => {
            observedInitData = initData;
            return input;
          },
        },
      }),
      stubGqlEntities(),
      stubGql(),
    );

    await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());

    expect(observedInitData).toEqual({ secret: "shh" });
  });

  it("uses original input when beforeRequest absent", async () => {
    let received: unknown = null;

    const factory = handleRESTRequestFactory(
      stubEntities("op_d", {
        handler: (_opts: unknown, input: unknown) => {
          received = input;
          return { ok: true };
        },
      }),
      stubGqlEntities(),
      stubGql(),
    );

    await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());

    expect(received).toEqual({});
  });

  it("returns 200 with handler result when afterRequest absent", async () => {
    const factory = handleRESTRequestFactory(
      stubEntities("op_e", {
        handler: () => ({ raw: "handler-output" }),
      }),
      stubGqlEntities(),
      stubGql(),
    );

    const res = await factory.handler(new URL("http://x/test"), "/test", "GET", fakeReq());

    expect(res.status).toBe(200);
  });

  it("returns 404 when no route matches the path", async () => {
    const factory = handleRESTRequestFactory(
      stubEntities("op_f", { handler: () => ({}) }),
      stubGqlEntities(),
      stubGql(),
    );

    const res = await factory.handler(
      new URL("http://x/no-such-path"),
      "/no-such-path",
      "GET",
      fakeReq(),
    );

    expect(res.status).toBe(404);
  });
});

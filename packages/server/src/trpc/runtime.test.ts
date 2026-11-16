import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { TRPCError } from "@trpc/server";
import { buildSchema } from "graphql";
import { z } from "zod";

import type { BunRequest } from "bun";
import type { CreateTRPCHandlerOptions } from "./runtime";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

let createTRPCHandler: typeof import("./runtime").createTRPCHandler;
// oxlint-disable-next-line typescript/no-explicit-any
let handleRESTRequestFactory: any;
let logger: typeof import("../logging").logger;

beforeAll(async () => {
  ({ createTRPCHandler } = await import("./runtime"));
  ({ handleRESTRequestFactory } = await import("../configuration/rest/handleRESTRequestFactory"));
  ({ logger } = await import("../logging"));
});

type StubOperation = {
  // oxlint-disable-next-line typescript/no-explicit-any
  handler?: (...args: any[]) => unknown;
  query?: string;
  input?: z.ZodType;
  cache?: Record<string, unknown>;
  timeout?: number;
  // oxlint-disable-next-line typescript/no-explicit-any
  hooks?: Record<string, any>;
  rest?: Record<string, unknown>;
};

const stubGql = (data: unknown = null, hasErrors = false) => ({
  handler: async () => ({ data }),
  // oxlint-disable-next-line typescript/no-explicit-any
  operatorQuery: async (..._args: any[]) => ({ data }),
  hasErrors: () => ({ hasErrors, errors: [] }),
});

// A role's real REST factory over stub entities: the router is built from the
// same `operationsEnhanced` and `operationRuntime` the server hands it.
const roleOf = (
  operations: Record<string, StubOperation>,
  gql: ReturnType<typeof stubGql> = stubGql(),
  auth: unknown = null,
) => ({
  handlers: {
    gql,
    rest: handleRESTRequestFactory(
      {
        operations: Object.fromEntries(
          Object.entries(operations).map(([name, operation]) => [
            name,
            { ...operation, rest: { path: `/${name}`, method: "GET", ...operation.rest } },
          ]),
        ),
        remoteRESTApis: [],
        queriesMap: {},
        getResolverSource: () => undefined,
        typeDefs: "",
        // Query operations run through `analyzeQuery`, which dereferences the schema.
        schema: buildSchema("type Query { ping: Boolean }"),
        introspection: null,
      },
      gql,
      auth,
    ),
  },
});

const USER = { role: "user", session: { role: "user", sub: "alice" } };

const handlerFor = (
  roles: Record<string, ReturnType<typeof roleOf>>,
  options: Partial<CreateTRPCHandlerOptions> = {},
) =>
  createTRPCHandler({
    endpoint: "/trpc",
    roles,
    maxBatchSize: 10,
    enableCors: true,
    resolveCaller: async () => USER,
    ...options,
  });

type Handler = ReturnType<typeof handlerFor>;

const query = (handler: Handler, path: string, input?: unknown) =>
  handler(
    new Request(
      `http://localhost/trpc/${path}${
        input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`
      }`,
    ) as BunRequest,
  );

const mutate = (handler: Handler, path: string, input?: unknown) =>
  handler(
    new Request(`http://localhost/trpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }) as BunRequest,
  );

const dataOf = async (response: Response) => (await response.json()).result.data;

const failureOf = async (response: Response) => {
  const { error } = await response.json();
  return { status: response.status, code: error.data.code, message: error.message };
};

const echo = {
  input: z.object({ id: z.number() }),
  handler: (_: unknown, input: unknown) => input,
};

describe("createTRPCHandler procedures", () => {
  it("answers a GET operation as a query, its input in ?input=", async () => {
    const handler = handlerFor({ user: roleOf({ echo }) });

    const response = await query(handler, "echo", { id: 7 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: { id: 7 } } });
  });

  it("answers any other method as a mutation, its input in the body", async () => {
    const handler = handlerFor({
      user: roleOf({ create: { ...echo, rest: { method: "POST" } } }),
    });

    const response = await mutate(handler, "create", { id: 7 });

    expect(response.status).toBe(200);
    expect(await dataOf(response)).toEqual({ id: 7 });
  });

  it("answers METHOD_NOT_SUPPORTED for a query sent as POST and a mutation sent as GET", async () => {
    const handler = handlerFor({
      user: roleOf({ echo, create: { ...echo, rest: { method: "PUT" } } }),
    });

    expect(await failureOf(await mutate(handler, "echo", { id: 7 }))).toEqual({
      status: 405,
      code: "METHOD_NOT_SUPPORTED",
      message: 'Unsupported POST-request to query procedure at path "echo"',
    });
    expect((await failureOf(await query(handler, "create", { id: 7 }))).code).toBe(
      "METHOD_NOT_SUPPORTED",
    );
  });

  it("answers BAD_REQUEST for an input the schema refuses", async () => {
    const handler = handlerFor({ user: roleOf({ echo }) });

    const failure = await failureOf(await query(handler, "echo", { id: "seven" }));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe("BAD_REQUEST");
  });

  it("takes no input without an input schema: what the client sends is ignored", async () => {
    const handler = handlerFor({
      user: roleOf({ plain: { handler: (_: unknown, variables: unknown) => ({ variables }) } }),
    });

    expect(await dataOf(await query(handler, "plain", { id: 7 }))).toEqual({ variables: {} });
    expect(await dataOf(await query(handler, "plain"))).toEqual({ variables: {} });
  });

  it("answers a batch, and refuses one over the cap whole", async () => {
    const handler = handlerFor({ user: roleOf({ echo }) }, { maxBatchSize: 2 });
    const batch = (ids: number[]) =>
      handler(
        new Request(
          `http://localhost/trpc/${ids.map(() => "echo").join(",")}?batch=1&input=${encodeURIComponent(
            JSON.stringify(Object.fromEntries(ids.map((id, index) => [index, { id }]))),
          )}`,
        ) as BunRequest,
      );

    expect(await (await batch([1, 2])).json()).toEqual([
      { result: { data: { id: 1 } } },
      { result: { data: { id: 2 } } },
    ]);

    expect(await failureOf(await batch([1, 2, 3]))).toEqual({
      status: 400,
      code: "BAD_REQUEST",
      message: "Batch call exceeds maximum size",
    });
  });

  it("reads the procedure name after the mounted path, PREFIX included", async () => {
    const handler = handlerFor({ user: roleOf({ echo }) }, { endpoint: "/api/trpc" });

    const response = await handler(
      new Request(
        `http://localhost/api/trpc/echo?input=${encodeURIComponent(JSON.stringify({ id: 7 }))}`,
      ) as BunRequest,
    );

    expect(await dataOf(response)).toEqual({ id: 7 });
  });

  it("logs one debug line per call", async () => {
    const debug = spyOn(logger("trpc"), "debug").mockImplementation((() => {}) as never);
    try {
      const handler = handlerFor({ user: roleOf({ echo }) });

      await query(handler, "echo", { id: 7 });

      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(
        { operation: "echo", type: "query", role: "user" },
        "trpc call",
      );
    } finally {
      debug.mockRestore();
    }
  });

  it("fails the boot on an operation named with a word tRPC reserves", () => {
    expect(() => handlerFor({ user: roleOf({ then: { handler: () => "ok" } }) })).toThrow(
      "Reserved words used in `router({})` call: then",
    );
  });
});

describe("createTRPCHandler roles", () => {
  const roles = () => ({
    user: roleOf({ echo }),
    admin: roleOf({ echo, secret: echo }),
  });

  it("serves a role its own operations", async () => {
    const handler = handlerFor(roles(), {
      resolveCaller: async () => ({ role: "admin", session: { role: "admin" } }),
    });

    expect(await dataOf(await query(handler, "secret", { id: 7 }))).toEqual({ id: 7 });
  });

  // The procedure lookup comes first, so a role cannot tell a hidden operation
  // from a name nobody serves: not by method, not by input.
  it("answers an ungranted operation as a name that does not exist", async () => {
    const handler = handlerFor(roles());
    const shapeOf = async (response: Response, name: string) => ({
      status: response.status,
      allow: response.headers.get("allow"),
      body: (await response.text()).replaceAll(name, "<name>"),
    });

    expect(await failureOf(await query(handler, "secret", { id: 7 }))).toEqual({
      status: 404,
      code: "NOT_FOUND",
      message: 'No procedure found on path "secret"',
    });

    for (const call of [
      (name: string) => query(handler, name, { id: 7 }),
      (name: string) => mutate(handler, name, { id: 7 }),
      (name: string) => query(handler, name, { id: "seven" }),
    ]) {
      expect(await shapeOf(await call("secret"), "secret")).toEqual(
        await shapeOf(await call("missing"), "missing"),
      );
    }
  });

  it("does not serve the auth routes", async () => {
    const handler = handlerFor({ user: roleOf({ echo }, stubGql(), { enabled: true }) });

    expect((await failureOf(await mutate(handler, "login", {}))).code).toBe("NOT_FOUND");
    expect((await failureOf(await mutate(handler, "logout"))).code).toBe("NOT_FOUND");
    expect((await failureOf(await mutate(handler, "refresh"))).code).toBe("NOT_FOUND");
    expect((await failureOf(await query(handler, "me"))).code).toBe("NOT_FOUND");
  });

  it("answers UNAUTHORIZED for an operation the role's schema rejects", async () => {
    const handler = handlerFor({
      user: roleOf({ ping: { query: "query { ping }" } }, stubGql(null, true)),
    });

    expect(await failureOf(await query(handler, "ping"))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
      message: "You are not authorized",
    });
  });
});

describe("createTRPCHandler pipeline", () => {
  it("hands beforeRequest the input, no REST source, and init's result", async () => {
    const seen: unknown[] = [];
    const handler = handlerFor({
      user: roleOf({
        echo: {
          ...echo,
          hooks: {
            init: () => ({ token: "t" }),
            beforeRequest: (context: { input: { id: number } }, initData: unknown) => {
              seen.push(context, initData);
              return { id: context.input.id + 1 };
            },
          },
        },
      }),
    });

    expect(await dataOf(await query(handler, "echo", { id: 7 }))).toEqual({ id: 8 });
    expect(seen).toEqual([
      { input: { id: 7 }, pathParams: undefined, queryParams: undefined, body: undefined },
      { token: "t" },
    ]);
  });

  it("hands a handler the options a REST call hands it, then runs afterRequest", async () => {
    const gql = stubGql();
    let options: { gqlQuery?: unknown } = {};
    const handler = handlerFor({
      user: roleOf(
        {
          echo: {
            ...echo,
            handler: (handlerOptions: typeof options, input: unknown) => {
              options = handlerOptions;
              return input;
            },
            hooks: {
              afterRequest: ({ output }: { output: object }) => ({ ...output, shaped: true }),
            },
          },
        },
        gql,
      ),
    });

    expect(await dataOf(await query(handler, "echo", { id: 7 }))).toEqual({ id: 7, shaped: true });
    expect(options.gqlQuery).toBe(gql.operatorQuery);
    expect(Object.keys(options).sort()).toEqual(["databases", "gqlQuery", "queues", "repository"]);
  });

  it("runs a query operation as its caller and answers the payload, unwrapped", async () => {
    const calls: unknown[][] = [];
    const gql = {
      ...stubGql(),
      operatorQuery: async (...args: unknown[]) => {
        calls.push(args);
        return { data: { ping: true } };
      },
    };
    const user = roleOf(
      { ping: { query: "query { ping }", input: z.object({ id: z.number() }), timeout: 250 } },
      gql,
    );
    const handler = handlerFor({ user });

    const response = await query(handler, "ping", { id: 7 });

    expect(await response.json()).toEqual({ result: { data: { ping: true } } });
    const [queryStructure, variables, req, session, timeout] = calls[0];
    expect(queryStructure).toBe(user.handlers.rest.operationsEnhanced.ping.queryStructure);
    expect(variables).toEqual({ id: 7 });
    expect(req).toBeInstanceOf(Request);
    expect(session).toEqual(USER.session);
    expect(timeout).toBe(250);
  });

  it("runs afterRequest on a query operation's payload", async () => {
    const handler = handlerFor({
      user: roleOf(
        {
          ping: {
            query: "query { ping }",
            hooks: {
              afterRequest: ({ output }: { output: { ping: boolean } }) => ({
                pinged: output.ping,
              }),
            },
          },
        },
        stubGql({ ping: true }),
      ),
    });

    expect(await dataOf(await query(handler, "ping"))).toEqual({ pinged: true });
  });

  it("masks a throw that is not a TRPCError, and logs it", async () => {
    const error = spyOn(logger("trpc"), "error").mockImplementation((() => {}) as never);
    const boom = new Error("connect ECONNREFUSED postgres://app:hunter2@db/app");
    try {
      const handler = handlerFor({
        user: roleOf({
          broken: {
            handler: () => {
              throw boom;
            },
          },
        }),
      });

      const response = await query(handler, "broken");
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(body).error).toMatchObject({
        message: "Internal server error",
        data: { code: "INTERNAL_SERVER_ERROR" },
      });
      expect(body).not.toContain("hunter2");
      expect(body).not.toContain("stack");
      expect(error).toHaveBeenCalledWith(
        { err: boom, operation: "broken", role: "user" },
        "trpc operation failed",
      );
    } finally {
      error.mockRestore();
    }
  });

  it("passes a TRPCError through, a second copy of the package's included", async () => {
    const error = spyOn(logger("trpc"), "error").mockImplementation((() => {}) as never);
    try {
      const handler = handlerFor({
        user: roleOf({
          taken: {
            handler: () => {
              throw new TRPCError({ code: "CONFLICT", message: "Already there" });
            },
          },
          foreign: {
            hooks: {
              beforeRequest: () => {
                throw Object.assign(new Error("Not yours"), {
                  name: "TRPCError",
                  code: "FORBIDDEN",
                });
              },
            },
            handler: () => "unreached",
          },
        }),
      });

      expect(await failureOf(await query(handler, "taken"))).toEqual({
        status: 409,
        code: "CONFLICT",
        message: "Already there",
      });
      expect(await failureOf(await query(handler, "foreign"))).toEqual({
        status: 403,
        code: "FORBIDDEN",
        message: "Not yours",
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("createTRPCHandler boot warning", () => {
  it("names once the operations whose arguments only REST declares", () => {
    const warn = spyOn(logger("trpc"), "warn").mockImplementation((() => {}) as never);
    const operations = {
      byId: { rest: { pathParams: z.object({ id: z.string() }) }, handler: () => "ok" },
      search: { rest: { queryParams: z.object({ q: z.string() }) }, handler: () => "ok" },
      create: {
        rest: { method: "POST", body: z.object({ title: z.string() }) },
        input: z.object({ title: z.string() }),
        handler: () => "ok",
      },
      plain: { handler: () => "ok" },
    };
    try {
      handlerFor({ user: roleOf(operations), admin: roleOf(operations) });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { operations: ["byId", "search"] },
        "operations declare REST parameters but no input: tRPC serves them without arguments",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when every operation with REST parameters has an input", () => {
    const warn = spyOn(logger("trpc"), "warn").mockImplementation((() => {}) as never);
    try {
      handlerFor({ user: roleOf({ echo }) });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createTRPCHandler cache", () => {
  const CACHE = { ttl: 10_000, max: 10 };

  // A counting GraphQL stub, optionally slow enough for calls to overlap.
  const countingGql = (delayMs = 0) => {
    const gql = {
      ...stubGql(),
      calls: 0,
      operatorQuery: async () => {
        gql.calls++;
        if (delayMs) await Bun.sleep(delayMs);
        return { data: { ping: true } };
      },
    };
    return gql;
  };

  it("stores a miss after afterRequest, and answers a hit without the query or the hook", async () => {
    const { getCache } = await import("../singletons/cache");
    const gql = countingGql();
    let hooks = 0;
    const handler = handlerFor({
      user: roleOf(
        {
          trpc_cached: {
            query: "query { ping }",
            input: z.object({ id: z.number() }),
            cache: CACHE,
            hooks: {
              afterRequest: ({ output }: { output: object }) => ({ ...output, n: ++hooks }),
            },
          },
        },
        gql,
      ),
    });

    const first = await dataOf(await query(handler, "trpc_cached", { id: 7 }));
    const second = await dataOf(await query(handler, "trpc_cached", { id: 7 }));

    expect(first).toEqual({ ping: true, n: 1 });
    expect(second).toEqual(first);
    expect({ queries: gql.calls, hooks }).toEqual({ queries: 1, hooks: 1 });

    const store = getCache("trpc_cached")!;
    const [key] = await store.keys();
    expect(key).toBe(
      JSON.stringify({ trpc: "trpc_cached", variables: { id: 7 }, sub: "alice", role: "user" }),
    );
    expect(await store.get(key)).toBe(JSON.stringify({ ping: true, n: 1 }));
  });

  it("keeps one entry per caller: another sub or another role shares none", async () => {
    const { getCache } = await import("../singletons/cache");
    const gql = countingGql();
    const operations = { trpc_cached_callers: { query: "query { ping }", cache: CACHE } };
    let caller = { role: "user", session: { role: "user", sub: "alice" } };
    const handler = handlerFor(
      { user: roleOf(operations, gql), admin: roleOf(operations, gql) },
      { resolveCaller: async () => caller },
    );

    await query(handler, "trpc_cached_callers");
    caller = { role: "user", session: { role: "user", sub: "bob" } };
    await query(handler, "trpc_cached_callers");
    caller = { role: "admin", session: { role: "admin", sub: "alice" } };
    await query(handler, "trpc_cached_callers");
    caller = { role: "user", session: { role: "user", sub: "alice" } };
    await query(handler, "trpc_cached_callers");

    expect(gql.calls).toBe(3);
    expect(await getCache("trpc_cached_callers")!.keys()).toHaveLength(3);
  });

  it("answers an afterRequest that returns nothing, and stores nothing", async () => {
    const { getCache } = await import("../singletons/cache");
    const gql = countingGql();
    const handler = handlerFor({
      user: roleOf(
        {
          trpc_cached_nothing: {
            query: "query { ping }",
            cache: CACHE,
            hooks: { afterRequest: () => undefined },
          },
        },
        gql,
      ),
    });

    const first = await query(handler, "trpc_cached_nothing");
    await query(handler, "trpc_cached_nothing");

    expect(await first.json()).toEqual({ result: {} });
    expect(gql.calls).toBe(2);
    expect(await getCache("trpc_cached_nothing")!.keys()).toEqual([]);
  });

  it("is cleared by InvalidationHelper, by variables or whole", async () => {
    const { InvalidationHelper, getCache } = await import("../singletons/cache");
    const gql = countingGql();
    const handler = handlerFor({
      user: roleOf(
        {
          trpc_cached_invalidated: {
            query: "query { ping }",
            input: z.object({ id: z.number() }),
            cache: CACHE,
          },
        },
        gql,
      ),
    });
    const store = () => getCache("trpc_cached_invalidated")!;

    await query(handler, "trpc_cached_invalidated", { id: 7 });
    await query(handler, "trpc_cached_invalidated", { id: 8 });
    expect(await store().keys()).toHaveLength(2);

    await InvalidationHelper.invalidate("trpc_cached_invalidated", { id: 7 });
    expect(await store().keys()).toEqual([
      JSON.stringify({
        trpc: "trpc_cached_invalidated",
        variables: { id: 8 },
        sub: "alice",
        role: "user",
      }),
    ]);

    await query(handler, "trpc_cached_invalidated", { id: 7 });
    expect(gql.calls).toBe(3);

    await InvalidationHelper.invalidate("trpc_cached_invalidated");
    expect(await store().keys()).toEqual([]);
  });

  it("shares one execution between concurrent misses on one key", async () => {
    const gql = countingGql(10);
    let hooks = 0;
    const handler = handlerFor({
      user: roleOf(
        {
          trpc_cached_herd: {
            query: "query { ping }",
            cache: CACHE,
            hooks: {
              afterRequest: ({ output }: { output: object }) => ({ ...output, n: ++hooks }),
            },
          },
        },
        gql,
      ),
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => query(handler, "trpc_cached_herd")),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect({ queries: gql.calls, hooks }).toEqual({ queries: 1, hooks: 1 });
    expect(new Set(bodies)).toEqual(
      new Set([JSON.stringify({ result: { data: { ping: true, n: 1 } } })]),
    );
  });

  it("keeps its entries apart from the operation's REST entries", async () => {
    const { getCache } = await import("../singletons/cache");
    const gql = countingGql();
    const user = roleOf({ trpc_cached_rest: { query: "query { ping }", cache: CACHE } }, gql);
    const handler = handlerFor({ user });

    await query(handler, "trpc_cached_rest");
    await user.handlers.rest.handler(
      new URL("http://localhost/trpc_cached_rest"),
      "/trpc_cached_rest",
      "GET",
      new Request("http://localhost/trpc_cached_rest"),
      USER.session,
    );
    await query(handler, "trpc_cached_rest");

    expect(gql.calls).toBe(2);
    expect(await getCache("trpc_cached_rest")!.keys()).toHaveLength(2);
  });
});

describe("createTRPCHandler caller", () => {
  const LIMITED = { ...USER, limit: { allowed: false, retryAfterMs: 1500 } };

  it("answers a rate-limited caller TOO_MANY_REQUESTS with Retry-After, running nothing", async () => {
    let runs = 0;
    const handler = handlerFor(
      { user: roleOf({ echo: { ...echo, handler: () => ++runs } }) },
      { resolveCaller: async () => LIMITED },
    );

    const response = await query(handler, "echo", { id: 7 });

    expect(response.headers.get("retry-after")).toBe("2");
    expect(await failureOf(response)).toEqual({
      status: 429,
      code: "TOO_MANY_REQUESTS",
      message: "TOO_MANY_REQUESTS",
    });
    // The context is read before the input is parsed.
    expect((await failureOf(await query(handler, "echo", { id: "seven" }))).status).toBe(429);
    expect(runs).toBe(0);
  });

  // tRPC looks the procedure up and checks the method before it reads the
  // context, so these two answers stay what they are; the header still rides them.
  it("keeps Retry-After on a rate-limited caller's NOT_FOUND and METHOD_NOT_SUPPORTED", async () => {
    const handler = handlerFor({ user: roleOf({ echo }) }, { resolveCaller: async () => LIMITED });

    const missing = await query(handler, "missing");
    const wrongMethod = await mutate(handler, "echo", { id: 7 });

    expect([missing.status, missing.headers.get("retry-after")]).toEqual([404, "2"]);
    expect([wrongMethod.status, wrongMethod.headers.get("retry-after")]).toEqual([405, "2"]);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  it("never sends Retry-After 0: under a second rounds up to one, as S429 does", async () => {
    const handler = handlerFor(
      { user: roleOf({ echo }) },
      { resolveCaller: async () => ({ ...USER, limit: { allowed: false, retryAfterMs: 0 } }) },
    );

    const response = await query(handler, "echo", { id: 7 });

    expect([response.status, response.headers.get("retry-after")]).toEqual([429, "1"]);
  });

  it("sends no Retry-After to a caller within its limit", async () => {
    const handler = handlerFor(
      { user: roleOf({ echo }) },
      { resolveCaller: async () => ({ ...USER, limit: { allowed: true, retryAfterMs: 0 } }) },
    );

    const response = await query(handler, "echo", { id: 7 });

    expect(response.status).toBe(200);
    expect(response.headers.has("retry-after")).toBe(false);
  });

  it("logs a caller it cannot resolve and answers nothing of the error", async () => {
    const error = spyOn(logger("trpc"), "error").mockImplementation((() => {}) as never);
    const boom = new Error("Cannot read properties of undefined (reading 'handlers')");
    try {
      const handler = handlerFor(
        { user: roleOf({ echo }) },
        {
          resolveCaller: async () => {
            throw boom;
          },
        },
      );

      const response = await query(handler, "echo", { id: 7 });
      const body = await response.text();

      // No role is known, so the request goes to a router that holds nothing.
      expect(response.status).toBe(404);
      expect(JSON.parse(body).error.data.code).toBe("NOT_FOUND");
      expect(body).not.toContain("handlers");
      expect(error).toHaveBeenCalledWith({ err: boom }, "trpc caller resolution failed");
    } finally {
      error.mockRestore();
    }
  });
});

describe("createTRPCHandler CORS", () => {
  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
  };
  const corsOf = (response: Response) =>
    Object.fromEntries(Object.keys(CORS).map((name) => [name, response.headers.get(name)]));

  it("sends the CORS headers every REST response carries, on answers and errors alike", async () => {
    const handler = handlerFor({ user: roleOf({ echo }) });

    expect(corsOf(await query(handler, "echo", { id: 7 }))).toEqual(CORS);
    expect(corsOf(await query(handler, "echo", { id: "seven" }))).toEqual(CORS);
    expect(corsOf(await query(handler, "missing"))).toEqual(CORS);
  });

  it("answers a preflight without resolving a caller", async () => {
    let resolved = 0;
    const handler = handlerFor(
      { user: roleOf({ echo }) },
      {
        resolveCaller: async () => {
          resolved++;
          return USER;
        },
      },
    );

    const response = await handler(
      new Request("http://localhost/trpc/echo", { method: "OPTIONS" }) as BunRequest,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(corsOf(response)).toEqual(CORS);
    expect(resolved).toBe(0);
  });

  it("leaves a preflight to tRPC when CORS is off", async () => {
    let resolved = 0;
    const handler = handlerFor(
      { user: roleOf({ echo }) },
      {
        enableCors: false,
        resolveCaller: async () => {
          resolved++;
          return USER;
        },
      },
    );

    const response = await handler(
      new Request("http://localhost/trpc/echo", { method: "OPTIONS" }) as BunRequest,
    );

    expect(response.status).not.toBe(200);
    expect(resolved).toBe(1);
  });
});

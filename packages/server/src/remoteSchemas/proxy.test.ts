import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { RemoteSchemaResolved } from "./types";

import { attributeOf, installSpanSink, stringAttribute } from "../__test/spanSink";
import { startSpan, withActiveSpan } from "../observability/tracing";
import { proxyRemoteField } from "./proxy";

const createMockRemoteSchema = (
  overrides: Partial<RemoteSchemaResolved> = {},
): RemoteSchemaResolved => ({
  config: {
    name: "test",
    url: "http://localhost:4000/graphql",
    timeout: 5000,
    headers: { "X-Api-Key": "test-key" },
    forwardHeaders: ["authorization"],
  },
  prefix: "test_",
  typeDefsSDL: "",
  queryFields: [],
  mutationFields: [],
  prefixMap: {
    toPrefixed: { User: "test_User" },
  },
  ...overrides,
});

describe("Remote Schema Proxy", () => {
  it("should send correct query to remote endpoint", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { users: [{ id: "1", name: "Alice" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await proxyRemoteField(
        {
          name: "test_users",
          isArray: true,
          arguments: {},
          selections: [
            {
              name: "id",
              isArray: false,
              arguments: {},
            },
            {
              name: "name",
              isArray: false,
              arguments: {},
            },
          ],
        },
        createMockRemoteSchema(),
        "users",
        {},
        "query",
      );

      expect(result).toEqual([{ id: "1", name: "Alice" }]);

      // Verify fetch was called with correct URL and headers
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = (
        fetchMock as unknown as {
          mock: {
            calls: [string, RequestInit & { headers: Record<string, string> }][];
          };
        }
      ).mock.calls[0];
      expect(url).toBe("http://localhost:4000/graphql");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body as string);
      expect(body.query).toContain("query");
      expect(body.query).toContain("users");

      expect(options.headers["X-Api-Key"]).toBe("test-key");
      expect(options.headers["Content-Type"]).toBe("application/json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should preserve aliases on nested selections", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { users: [{ userId: "1", userName: "Alice" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      await proxyRemoteField(
        {
          name: "test_users",
          isArray: true,
          arguments: {},
          selections: [
            {
              name: "id",
              alias: "userId",
              isArray: false,
              arguments: {},
            },
            {
              name: "name",
              alias: "userName",
              isArray: false,
              arguments: {},
            },
          ],
        },
        createMockRemoteSchema(),
        "users",
        {},
        "query",
      );

      const [, options] = (
        fetchMock as unknown as {
          mock: {
            calls: [string, RequestInit & { headers: Record<string, string> }][];
          };
        }
      ).mock.calls[0];
      const body = JSON.parse(options.body as string);
      expect(body.query).toContain("userId: id");
      expect(body.query).toContain("userName: name");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("answers __typename with the prefixed type name, under its alias", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              users: [
                {
                  __typename: "User",
                  kind: "User",
                  profile: null,
                  posts: [{ __typename: "Post", id: "1" }],
                },
                { __typename: "Unlisted", kind: "Unlisted", profile: null, posts: [] },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await proxyRemoteField(
        {
          name: "test_users",
          isArray: true,
          selections: [
            { name: "__typename" },
            { name: "__typename", alias: "kind" },
            { name: "profile", selections: [{ name: "__typename" }] },
            {
              name: "posts",
              isArray: true,
              selections: [{ name: "__typename" }, { name: "id" }],
            },
          ],
        },
        createMockRemoteSchema({
          prefixMap: {
            toPrefixed: { User: "test_User", Post: "test_Post" },
          },
        }),
        "users",
        {},
        "query",
      );

      expect(result).toEqual([
        {
          __typename: "test_User",
          kind: "test_User",
          profile: null,
          posts: [{ __typename: "test_Post", id: "1" }],
        },
        { __typename: "Unlisted", kind: "Unlisted", profile: null, posts: [] },
      ]);

      const [, options] = (
        fetchMock as unknown as {
          mock: {
            calls: [string, RequestInit & { headers: Record<string, string> }][];
          };
        }
      ).mock.calls[0];
      expect(JSON.parse(options.body as string).query).toBe(
        "query { users { __typename kind: __typename profile { __typename } posts { __typename id } } }",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should forward client headers", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { me: { id: "1" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const clientRequest = new Request("http://localhost:3000/graphql", {
        headers: {
          authorization: "Bearer token123",
          "x-custom": "should-not-forward",
        },
      });

      await proxyRemoteField(
        {
          name: "test_me",
          isArray: false,
          arguments: {},
          selections: [
            {
              name: "id",
              isArray: false,
              arguments: {},
            },
          ],
        },
        createMockRemoteSchema(),
        "me",
        {},
        "query",
        clientRequest,
      );

      const [, options] = (
        fetchMock as unknown as {
          mock: {
            calls: [string, RequestInit & { headers: Record<string, string> }][];
          };
        }
      ).mock.calls[0];
      expect(options.headers["authorization"]).toBe("Bearer token123");
      expect(options.headers["x-custom"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw on remote errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "Not authorized" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        proxyRemoteField(
          {
            name: "test_secret",
            isArray: false,
            arguments: {},
          },
          createMockRemoteSchema(),
          "secret",
          {},
          "query",
        ),
      ).rejects.toThrow("Not authorized");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw on non-200 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    try {
      await expect(
        proxyRemoteField(
          {
            name: "test_data",
            isArray: false,
            arguments: {},
          },
          createMockRemoteSchema(),
          "data",
          {},
          "query",
        ),
      ).rejects.toThrow("HTTP 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Remote Schema Proxy — what it writes upstream", () => {
  const originalFetch = globalThis.fetch;

  const upstream = (data: Record<string, unknown>) => {
    const fetchMock = mock((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return {
      fetchMock,
      sent: () =>
        (JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { query: string }).query,
    };
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("asks a field left with no selection for __typename, and answers it empty", async () => {
    const { sent } = upstream({ users: [{ __typename: "User" }, { __typename: "User" }] });

    const result = await proxyRemoteField(
      { name: "test_users", selections: [] },
      createMockRemoteSchema(),
      "users",
      {},
      "query",
    );

    expect(sent()).toBe("query { users { __typename } }");
    expect(result).toEqual([{}, {}]);
  });

  it("does the same for a nested field", async () => {
    const { sent } = upstream({ user: { id: "1", profile: { __typename: "Profile" } } });

    const result = await proxyRemoteField(
      { name: "test_user", selections: [{ name: "id" }, { name: "profile", selections: [] }] },
      createMockRemoteSchema(),
      "user",
      {},
      "query",
    );

    expect(sent()).toBe("query { user { id profile { __typename } } }");
    expect(result).toEqual({ id: "1", profile: {} });
  });
});

describe("Remote Schema Proxy — tracing", () => {
  let sink: ReturnType<typeof installSpanSink>;

  beforeEach(() => {
    sink = installSpanSink();
  });

  afterEach(() => {
    sink.restore();
  });

  const withFetchMock = async (run: () => Promise<unknown>) => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { users: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const [, options] = (
      fetchMock as unknown as {
        mock: { calls: [string, RequestInit & { headers: Record<string, string> }][] };
      }
    ).mock.calls[0];
    return options;
  };

  const proxy = () =>
    proxyRemoteField(
      { name: "test_users", isArray: true, arguments: {}, selections: [] },
      createMockRemoteSchema(),
      "users",
      {},
      "query",
    );

  it("spans the remote call as a client, naming the host but not the URL", async () => {
    await withFetchMock(proxy);

    const [span] = await sink.spans();

    expect(span!.name).toBe("graphoria.remote_schema");
    expect(span!.kind).toBe(3);
    expect(stringAttribute(span!, "http.request.method")).toBe("POST");
    expect(stringAttribute(span!, "server.address")).toBe("localhost:4000");
    expect(attributeOf(span!, "http.response.status_code")).toEqual({ intValue: "200" });
    expect(JSON.stringify(span)).not.toContain("/graphql");
  });

  it("carries a traceparent matching the span it opened", async () => {
    const options = await withFetchMock(proxy);

    const [span] = await sink.spans();

    expect(options.headers["traceparent"]).toBe(`00-${span!.traceId}-${span!.spanId}-01`);
  });

  it("continues the trace it was called inside", async () => {
    const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };

    await withFetchMock(() => withActiveSpan(startSpan("query Users", { parent }), proxy));

    const remote = (await sink.spans()).find((span) => span.name === "graphoria.remote_schema")!;

    expect(remote.traceId).toBe(parent.traceId);
  });

  it("sends no traceparent while tracing is disabled", async () => {
    sink.restore();

    const options = await withFetchMock(proxy);

    expect(options.headers["traceparent"]).toBeUndefined();
  });
});

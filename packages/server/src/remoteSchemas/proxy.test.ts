import { describe, expect, it, mock } from "bun:test";

import type { RemoteSchemaResolved } from "./types";

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
    toOriginal: { test_User: "User" },
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

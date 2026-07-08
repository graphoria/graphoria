import { describe, expect, it, mock } from "bun:test";

import type { RemoteRESTResolved, RemoteRESTRoute } from "./types";

import { proxyRemoteRESTRequest } from "./proxy";

const baseResolved: RemoteRESTResolved = {
  config: {
    name: "petstore",
    specUrl: "https://petstore.example.com/openapi.json",
    headers: { "x-api-key": "secret" },
    forwardHeaders: ["authorization"],
    timeout: 5000,
  },
  prefix: "petstore",
  baseUrl: "https://petstore.example.com",
  routes: [],
  openApiPaths: {},
  openApiSchemas: {},
};

const makeRoute = (method: string, originalPath: string): RemoteRESTRoute => ({
  method,
  originalPath,
  prefixedPath: `/petstore${originalPath}`,
});

describe("Remote REST Proxy", () => {
  it("should forward a GET request and return the remote response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1, name: "Fido" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("get", "/pets/{petId}");
      const clientReq = new Request("http://localhost:3000/rest/petstore/pets/1", {
        method: "GET",
        headers: { authorization: "Bearer token123" },
      });

      const response = await proxyRemoteRESTRequest(
        route,
        baseResolved,
        clientReq,
        { petId: "1" },
        "",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ id: 1, name: "Fido" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should substitute path parameters correctly", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("get", "/stores/{storeId}/pets/{petId}");
      const clientReq = new Request("http://localhost:3000/rest/petstore/stores/42/pets/7");

      await proxyRemoteRESTRequest(
        route,
        baseResolved,
        clientReq,
        { storeId: "42", petId: "7" },
        "",
      );

      expect(capturedUrl).toBe("https://petstore.example.com/stores/42/pets/7");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should append query string to target URL", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("get", "/pets");
      const clientReq = new Request("http://localhost:3000/rest/petstore/pets?limit=10&offset=0");

      await proxyRemoteRESTRequest(route, baseResolved, clientReq, {}, "limit=10&offset=0");

      expect(capturedUrl).toBe("https://petstore.example.com/pets?limit=10&offset=0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should merge static and forwarded headers", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("get", "/pets");
      const clientReq = new Request("http://localhost:3000/rest/petstore/pets", {
        headers: {
          authorization: "Bearer mytoken",
          "x-unrelated": "ignored",
        },
      });

      await proxyRemoteRESTRequest(route, baseResolved, clientReq, {}, "");

      expect(capturedHeaders["x-api-key"]).toBe("secret");
      expect(capturedHeaders["authorization"]).toBe("Bearer mytoken");
      expect(capturedHeaders["x-unrelated"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should forward body for POST requests", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: unknown = null;
    let capturedMethod = "";
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedMethod = init.method!;
      if (init.body) {
        const reader = (init.body as ReadableStream).getReader();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) chunks.push(result.value);
        }
        capturedBody = new TextDecoder().decode(Buffer.concat(chunks));
      }
      return new Response(JSON.stringify({ id: 99 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("post", "/pets");
      const clientReq = new Request("http://localhost:3000/rest/petstore/pets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Buddy" }),
      });

      const response = await proxyRemoteRESTRequest(route, baseResolved, clientReq, {}, "");

      expect(capturedMethod).toBe("POST");
      expect(response.status).toBe(201);
      expect(capturedBody).toBe(JSON.stringify({ name: "Buddy" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return remote error responses as-is", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("get", "/pets/{petId}");
      const clientReq = new Request("http://localhost:3000/rest/petstore/pets/999");

      const response = await proxyRemoteRESTRequest(
        route,
        baseResolved,
        clientReq,
        { petId: "999" },
        "",
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Not Found" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects with the AbortController error when the upstream exceeds the configured timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof globalThis.fetch;

    try {
      const route = makeRoute("get", "/slow");
      const clientReq = new Request("http://localhost:3000/rest/petstore/slow");
      const fastTimeout: RemoteRESTResolved = {
        ...baseResolved,
        config: { ...baseResolved.config, timeout: 25 },
      };

      let thrown: unknown;
      try {
        await proxyRemoteRESTRequest(route, fastTimeout, clientReq, {}, "");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect((thrown as { name?: string }).name).toBe("AbortError");
      expect(
        (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls,
      ).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

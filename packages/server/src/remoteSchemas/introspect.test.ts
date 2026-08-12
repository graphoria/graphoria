import { describe, expect, it, mock } from "bun:test";

import { introspectRemoteSchema } from "./introspect";

describe("Remote Schema Introspect", () => {
  it("should throw on non-200 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    try {
      await expect(
        introspectRemoteSchema({
          name: "test",
          url: "http://localhost:9999/graphql",
          timeout: 5000,
        }),
      ).rejects.toThrow("HTTP 404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw when response has no data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: "Bad" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        introspectRemoteSchema({
          name: "test",
          url: "http://localhost:9999/graphql",
          timeout: 5000,
        }),
      ).rejects.toThrow("returned no data");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should parse a valid introspection response", async () => {
    const { buildSchema, introspectionFromSchema } = await import("graphql");

    const schema = buildSchema(`
      type Query {
        hello: String
      }
    `);
    const introspectionResult = introspectionFromSchema(schema);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: introspectionResult }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    try {
      const result = await introspectRemoteSchema({
        name: "test",
        url: "http://localhost:9999/graphql",
        timeout: 5000,
      });

      const queryType = result.getQueryType();
      expect(queryType).toBeDefined();
      expect(queryType!.getFields().hello).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

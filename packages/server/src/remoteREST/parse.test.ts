import { describe, expect, it, mock } from "bun:test";

import { parseRemoteOpenAPI } from "./parse";

const sampleSpec = {
  openapi: "3.1.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/users": {
      get: { operationId: "getUsers", responses: {} },
    },
  },
};

const sampleYaml = `
openapi: "3.1.0"
info:
  title: Test
  version: "1.0.0"
paths:
  /users:
    get:
      operationId: getUsers
      responses: {}
`;

describe("Remote REST Parse", () => {
  it("should parse JSON from specUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(sampleSpec), { status: 200 })),
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await parseRemoteOpenAPI({
        name: "test",
        specUrl: "https://api.example.com/openapi.json",
      });

      expect(result.openapi).toBe("3.1.0");
      expect(result.paths).toHaveProperty("/users");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should parse YAML from specUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(sampleYaml, { status: 200 })),
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await parseRemoteOpenAPI({
        name: "test",
        specUrl: "https://api.example.com/openapi.yaml",
      });

      expect(result.openapi).toBe("3.1.0");
      expect(result.paths).toHaveProperty("/users");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw on HTTP error from specUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof globalThis.fetch;

    try {
      await expect(
        parseRemoteOpenAPI({
          name: "test",
          specUrl: "https://api.example.com/openapi.json",
        }),
      ).rejects.toThrow(/spec fetch failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should throw when neither specUrl nor specPath is provided", async () => {
    await expect(parseRemoteOpenAPI({ name: "test" })).rejects.toThrow(
      /requires either specUrl or specPath/,
    );
  });

  it("should throw on specPath file not found", async () => {
    await expect(
      parseRemoteOpenAPI({
        name: "test",
        specPath: "/nonexistent/path/openapi.json",
      }),
    ).rejects.toThrow(/spec file not found/);
  });
});

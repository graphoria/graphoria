import { describe, expect, it } from "bun:test";

import type { OpenAPIV3_1 } from "openapi-types";

import { transformRemoteREST } from "./transform";

const buildTestSpec = (
  paths: OpenAPIV3_1.PathsObject = {},
  schemas: Record<string, OpenAPIV3_1.SchemaObject> = {},
  servers: OpenAPIV3_1.ServerObject[] = [{ url: "https://api.example.com" }],
): OpenAPIV3_1.Document => ({
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0" },
  servers,
  paths,
  components: { schemas },
});

describe("Remote REST Transform", () => {
  it("should extract routes from spec paths", () => {
    const spec = buildTestSpec({
      "/users": {
        get: {
          operationId: "getUsers",
          summary: "List users",
          responses: {},
        },
        post: {
          operationId: "createUser",
          summary: "Create user",
          responses: {},
        },
      },
      "/users/{id}": {
        get: {
          operationId: "getUser",
          summary: "Get user by ID",
          responses: {},
        },
      },
    });

    const result = transformRemoteREST(spec, {
      name: "payments",
      url: "https://payments.example.com",
    });

    expect(result.prefix).toBe("payments");
    expect(result.baseUrl).toBe("https://payments.example.com");
    expect(result.routes).toHaveLength(3);

    const getUsers = result.routes.find((r) => r.method === "get" && r.originalPath === "/users");
    expect(getUsers).toBeDefined();
    expect(getUsers!.prefixedPath).toBe("/payments/users");
    expect(getUsers!.operationId).toBe("getUsers");

    const getUser = result.routes.find(
      (r) => r.method === "get" && r.originalPath === "/users/{id}",
    );
    expect(getUser).toBeDefined();
    expect(getUser!.prefixedPath).toBe("/payments/users/{id}");
  });

  it("should use config prefix when provided", () => {
    const spec = buildTestSpec({
      "/items": {
        get: { operationId: "getItems", responses: {} },
      },
    });

    const result = transformRemoteREST(spec, {
      name: "payments",
      url: "https://api.example.com",
      prefix: "pay",
    });

    expect(result.prefix).toBe("pay");
    expect(result.routes[0].prefixedPath).toBe("/pay/items");
  });

  it("should resolve base URL from spec servers when config url is omitted", () => {
    const spec = buildTestSpec({ "/test": { get: { responses: {} } } }, {}, [
      { url: "https://from-spec.example.com" },
    ]);

    const result = transformRemoteREST(spec, {
      name: "test",
    });

    expect(result.baseUrl).toBe("https://from-spec.example.com");
  });

  it("should prefer config url over spec servers", () => {
    const spec = buildTestSpec({ "/test": { get: { responses: {} } } }, {}, [
      { url: "https://from-spec.example.com" },
    ]);

    const result = transformRemoteREST(spec, {
      name: "test",
      url: "https://from-config.example.com",
    });

    expect(result.baseUrl).toBe("https://from-config.example.com");
  });

  it("should throw when no base URL can be resolved", () => {
    const spec = buildTestSpec({ "/test": { get: { responses: {} } } }, {}, []);

    expect(() => transformRemoteREST(spec, { name: "test" })).toThrow(/requires a base URL/);
  });

  it("should prefix component schemas", () => {
    const spec = buildTestSpec(
      {
        "/users": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      {
        User: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
          },
        },
      },
    );

    const result = transformRemoteREST(spec, {
      name: "payments",
      url: "https://api.example.com",
    });

    // Schemas should be prefixed
    expect(result.openApiSchemas).toHaveProperty("payments_User");
    expect(result.openApiSchemas["payments_User"]).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
      },
    });

    // $refs in paths should be updated
    const getOp = (result.openApiPaths["/payments/users"] as Record<string, unknown>)[
      "get"
    ] as OpenAPIV3_1.OperationObject;
    const response200 = getOp.responses!["200"] as OpenAPIV3_1.ResponseObject;
    const schema = response200.content!["application/json"].schema as OpenAPIV3_1.ReferenceObject;
    expect(schema.$ref).toBe("#/components/schemas/payments_User");
  });

  it("should generate prefixed OpenAPI paths", () => {
    const spec = buildTestSpec({
      "/orders": {
        get: { tags: ["orders"], responses: {} },
      },
    });

    const result = transformRemoteREST(spec, {
      name: "shop",
      url: "https://api.example.com",
    });

    expect(result.openApiPaths).toHaveProperty("/shop/orders");
    const op = (result.openApiPaths["/shop/orders"] as Record<string, unknown>)[
      "get"
    ] as OpenAPIV3_1.OperationObject;
    // Tags should be replaced with the prefix
    expect(op.tags).toEqual(["shop"]);
  });

  it("should strip trailing slash from base URL", () => {
    const spec = buildTestSpec({ "/test": { get: { responses: {} } } });

    const result = transformRemoteREST(spec, {
      name: "test",
      url: "https://api.example.com/",
    });

    expect(result.baseUrl).toBe("https://api.example.com");
  });

  it("should handle empty paths gracefully", () => {
    const spec = buildTestSpec({});

    const result = transformRemoteREST(spec, {
      name: "empty",
      url: "https://api.example.com",
    });

    expect(result.routes).toHaveLength(0);
    expect(result.openApiPaths).toEqual({});
  });
});

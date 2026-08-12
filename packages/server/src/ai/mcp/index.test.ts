process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";

import type { AnalyzedConfiguration } from "../../configuration";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { createMCPRoutes } = await import("./index");

const buildAnalyzedConfig = (): AnalyzedConfiguration => {
  const role = getSchema({
    tables: StoreMSSQL.tables,
    storedProcedures: StoreMSSQL.storedProcedures,
    queues: [],
    operations: {},
    remoteSchemas: [],
    remoteREST: [],
  });
  return {
    databases: [],
    roles: { anonymous: role },
    openapi: {
      openapi: "3.1.0",
      info: { title: "test", version: "1.0.0" },
      paths: {},
    },
    queues: [],
    auth: { enabled: false },
  } as unknown as AnalyzedConfiguration;
};

const initRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      id: 1,
    }),
  });

describe("createMCPRoutes admin-secret gate", () => {
  it("returns 401 when requireAdminSecret=true and header missing", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      adminSecret: "shh",
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toMatch(/admin secret/i);
  });

  it("returns 401 on a mismatched secret", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      adminSecret: "shh",
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("passes through when the header matches", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      adminSecret: "shh",
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "shh" }));
    expect(res.status).not.toBe(401);
  });

  it("does not gate when requireAdminSecret is false", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: false,
    });
    const res = await routes.POST(initRequest());
    expect(res.status).not.toBe(401);
  });

  it("GET and DELETE always return 405", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig());
    const get = await routes.GET(new Request("http://localhost/mcp"));
    const del = await routes.DELETE(new Request("http://localhost/mcp"));
    expect(get.status).toBe(405);
    expect(del.status).toBe(405);
  });
});

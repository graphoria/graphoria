process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AnalyzedConfiguration } from "../../configuration";
import type { AuditEvent } from "../../logging/audit";
import type { Env } from "../../types/env";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { createMCPRoutes } = await import("./index");
const { setAuditLog } = await import("../../logging/audit");
const { createCapabilityAuthorizer } = await import("../../authentication/capabilities");

const authorizer = (admin: string[], mcp: string[] = []) =>
  createCapabilityAuthorizer(
    {
      admin: { secrets: admin, header: "x-admin-secret" },
      console: { readSecrets: [], writeSecrets: [] },
      ai: { secrets: ["ai-shh"], mcp: { secrets: mcp } },
    } as unknown as Env,
    { warn: () => {} },
  );

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
      authorize: authorizer(["shh"]),
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
      authorize: authorizer(["shh"]),
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("passes through when the header matches", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer(["shh"]),
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "shh" }));
    expect(res.status).not.toBe(401);
  });

  it("passes through when the header matches a previous secret", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer(["shh", "old-shh"]),
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "old-shh" }));
    expect(res.status).not.toBe(401);
  });

  it("returns 401 when the secret set is empty", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer([]),
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "" }));
    expect(res.status).toBe(401);
  });

  it("passes through with the MCP credential", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer(["shh"], ["mcp-shh"]),
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "mcp-shh" }));
    expect(res.status).not.toBe(401);
  });

  it("returns 401 for a credential scoped to another surface", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer(["shh"], ["mcp-shh"]),
      adminSecretHeader: "x-admin-secret",
    });
    const res = await routes.POST(initRequest({ "x-admin-secret": "ai-shh" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the gate is on but no authorizer was given", async () => {
    const routes = createMCPRoutes(buildAnalyzedConfig(), { requireAdminSecret: true });
    const res = await routes.POST(initRequest({ "x-admin-secret": "anything" }));
    expect(res.status).toBe(401);
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

describe("createMCPRoutes audit", () => {
  let records: AuditEvent[];
  const gated = () =>
    createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer(["shh"]),
      adminSecretHeader: "x-admin-secret",
    });

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  it("records one admin-secret use with the caller address when the gate passes", async () => {
    await gated().POST(initRequest({ "x-admin-secret": "shh" }), {
      requestIP: () => ({ address: "10.0.0.9" }),
    });

    expect(records).toEqual([
      {
        action: "admin_secret.used",
        actor: { type: "admin_secret", scope: "all", ip: "10.0.0.9" },
        target: { kind: "mcp" },
      },
    ]);
  });

  it("records the MCP credential as scoped when it passes the gate", async () => {
    await createMCPRoutes(buildAnalyzedConfig(), {
      requireAdminSecret: true,
      authorize: authorizer(["shh"], ["mcp-shh"]),
      adminSecretHeader: "x-admin-secret",
    }).POST(initRequest({ "x-admin-secret": "mcp-shh" }), {
      requestIP: () => ({ address: "10.0.0.9" }),
    });

    expect(records).toEqual([
      {
        action: "admin_secret.used",
        actor: { type: "admin_secret", scope: "mcp", ip: "10.0.0.9" },
        target: { kind: "mcp" },
      },
    ]);
  });

  it("records nothing when the gate rejects", async () => {
    await gated().POST(initRequest({ "x-admin-secret": "wrong" }));
    expect(records).toEqual([]);
  });

  it("records nothing when the gate is off", async () => {
    await createMCPRoutes(buildAnalyzedConfig(), { requireAdminSecret: false }).POST(initRequest());
    expect(records).toEqual([]);
  });
});

process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { OpenAPIV3_1 } from "openapi-types";
import type { AnalyzedConfiguration } from "../../configuration";
import type { AuditEvent } from "../../logging/audit";
import type { McpCaller } from "./index";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { createMCPRoutes } = await import("./index");
const { setAuditLog } = await import("../../logging/audit");

const OPENAPI: OpenAPIV3_1.Document = {
  openapi: "3.1.0",
  info: { title: "test", version: "1.0.0" },
  paths: {},
};

const fullRole = getSchema({
  tables: StoreMSSQL.tables,
  storedProcedures: StoreMSSQL.storedProcedures,
  queues: [],
  operations: {},
  remoteSchemas: [],
  remoteREST: [],
});

/** `superadmin` lists every table, `anonymous` the first one only. */
const buildAnalyzedConfig = (): AnalyzedConfiguration =>
  ({
    roles: {
      superadmin: fullRole,
      anonymous: { ...fullRole, tables: fullRole.tables.slice(0, 1) },
    },
  }) as unknown as AnalyzedConfiguration;

const anonymous: McpCaller = {
  role: "anonymous",
  session: { sub: "anonymous", role: "anonymous" },
};
const adminSecret: McpCaller = {
  role: "superadmin",
  session: { sub: "superadmin", role: "superadmin", authMethod: "admin_secret" },
  scope: "all",
};

const routesFor = (resolveCaller: () => Promise<McpCaller>, requireAdminSecret = false) =>
  createMCPRoutes(buildAnalyzedConfig(), {
    requireAdminSecret,
    resolveCaller,
    openapiFor: () => OPENAPI,
  });

const routesAs = (caller: McpCaller, requireAdminSecret = false) =>
  routesFor(async () => caller, requireAdminSecret);

const listTables = () =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_entities", arguments: { kind: "table" } },
      id: 1,
    }),
  });

const toolJson = async (response: Response) => {
  const event = (await response.text()).split("\n").find((line) => line.startsWith("data: "))!;
  const message = JSON.parse(event.slice("data: ".length)) as {
    result: { content: { text: string }[] };
  };
  return JSON.parse(message.result.content[0]!.text) as unknown[];
};

describe("createMCPRoutes caller", () => {
  it("serves the caller's role", async () => {
    expect(await toolJson(await routesAs(anonymous).POST(listTables()))).toHaveLength(1);
    expect(await toolJson(await routesAs(adminSecret).POST(listTables()))).toHaveLength(
      StoreMSSQL.tables.length,
    );
  });

  it("answers 400 when the caller cannot be resolved", async () => {
    const routes = routesFor(async () => {
      throw new TypeError("no such role");
    });

    expect((await routes.POST(listTables())).status).toBe(400);
  });

  it("answers 400 for a role the configuration does not define, an inherited name included", async () => {
    for (const role of ["ghost", "constructor", "__proto__"]) {
      const caller: McpCaller = { role, session: { sub: "ana", role, jti: "j" } };

      expect((await routesAs(caller).POST(listTables())).status).toBe(400);
    }
  });

  it("answers 429 with Retry-After when the caller is over its limit", async () => {
    const res = await routesAs({
      ...anonymous,
      limit: { allowed: false, retryAfterMs: 2500 },
    }).POST(listTables());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3");
  });

  it("GET and DELETE always return 405", async () => {
    const routes = routesAs(anonymous);

    expect((await routes.GET(new Request("http://localhost/mcp"))).status).toBe(405);
    expect((await routes.DELETE(new Request("http://localhost/mcp"))).status).toBe(405);
  });
});

describe("createMCPRoutes credential gate", () => {
  it("lets an anonymous caller through while the gate is off", async () => {
    expect((await routesAs(anonymous).POST(listTables())).status).toBe(200);
  });

  it("refuses an anonymous caller while the gate is on", async () => {
    expect((await routesAs(anonymous, true).POST(listTables())).status).toBe(401);
  });

  it("lets the admin secret through", async () => {
    expect((await routesAs(adminSecret, true).POST(listTables())).status).toBe(200);
  });

  it("lets the MCP credential through", async () => {
    const mcpSecret: McpCaller = {
      role: "anonymous",
      session: { sub: "mcp", role: "anonymous", authMethod: "admin_secret" },
      scope: "mcp",
    };

    expect((await routesAs(mcpSecret, true).POST(listTables())).status).toBe(200);
  });

  it("lets a verified bearer token through", async () => {
    const token: McpCaller = {
      role: "anonymous",
      session: { sub: "ana", role: "anonymous", jti: "jti-1" },
    };

    expect((await routesAs(token, true).POST(listTables())).status).toBe(200);
  });
});

describe("createMCPRoutes audit", () => {
  let records: AuditEvent[];

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  it("leaves the admin-secret record to the caller resolver", async () => {
    await routesAs(adminSecret, true).POST(listTables());

    expect(records).toEqual([]);
  });
});

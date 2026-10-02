import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { AuditEvent } from "../../logging/audit";
import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";
import { fieldName } from "./config";
import { callMcpTool } from "./mcp";

/**
 * A scoped credential opens exactly the surface it names, the admin secret
 * still opens all of them, and the audit record says which one was used. The
 * console-read credential — the acceptance case — can neither publish to a
 * queue nor reach the agent.
 *
 * PostgreSQL only: nothing here touches the query builder.
 */

const ENGINE = "pg" as const;
const CONSOLE_PATH = "/_console";

const READ_SECRET = "console-read-secret";
const WRITE_SECRET = "console-write-secret";
const AI_SECRET = "agent-secret";
const MCP_SECRET = "mcp-secret";

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
  id: 1,
});

const cookieNamed = (response: Response, name: string): string => {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie was set`);
  return header.split(";")[0]!;
};

describe.skipIf(!integrationEnabled)("scoped admin credentials", () => {
  let started: StartedServer;
  let records: AuditEvent[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let setAuditLog: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let aiModule: any;

  const adminSecret = () => process.env["ADMIN_SECRET"]!;
  const url = (path: string) => `http://localhost:${started.context.server.port}${path}`;

  beforeAll(async () => {
    started = await startServer({
      engine: ENGINE,
      config: { ai: { enabled: true } } as never,
      env: {
        console: {
          enabled: true,
          endpoint: CONSOLE_PATH,
          sessionExpiresIn: "1h",
          readSecrets: [READ_SECRET],
          writeSecrets: [WRITE_SECRET],
        },
        ai: {
          enabled: true,
          graphqlEnabled: true,
          restEnabled: true,
          secrets: [AI_SECRET],
          secretRole: "superadmin",
          mcp: {
            enabled: true,
            endpoint: "/mcp",
            requireAdminSecret: true,
            secrets: [MCP_SECRET],
            secretRole: "anonymous",
            maxQueryDepth: undefined,
            disabledTools: [],
            disabledResources: [],
            disabledPrompts: [],
          },
          systemPrompt: undefined,
          promptTemplate: undefined,
        },
      },
    });

    ({ setAuditLog } = await import("../../logging/audit"));
    aiModule = await import("../../singletons/ai");
  });

  afterAll(async () => {
    await started?.stop();
  });

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event: AuditEvent) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  const consoleLogin = async (secret: string) =>
    Bun.fetch(url(`${CONSOLE_PATH}/api/login`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });

  const consolePost = (path: string, cookie: string, body: object) =>
    Bun.fetch(url(`${CONSOLE_PATH}/api/${path}`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  const ask = (secret: string) =>
    started.context.rest("/ai", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ prompt: "how many users?" }),
    });

  const mcp = async (secret: string) => {
    const response = await Bun.fetch(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-admin-secret": secret,
      },
      body: initialize,
    });
    await response.body?.cancel();
    return response.status;
  };

  describe("console", () => {
    it("issues a read-only session to the read credential", async () => {
      const login = await consoleLogin(READ_SECRET);
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({ expiresIn: 3600, scope: "read" });
      expect(records).toEqual([
        {
          action: "console.login",
          outcome: "success",
          actor: { type: "admin_secret", scope: "console:read", ip: expect.any(String) },
          target: { kind: "console" },
        },
      ]);
    });

    it("refuses a queue publish and a cron action to a read-only session", async () => {
      const cookie = cookieNamed(await consoleLogin(READ_SECRET), "graphoria_console_session");
      records = [];

      const publish = await consolePost("queues/publish", cookie, {
        publisher: "orders",
        message: "m",
      });
      const cron = await consolePost("cron", cookie, { name: "job", action: "trigger" });

      expect(publish.status).toBe(403);
      expect(await publish.json()).toEqual({
        errors: [{ message: "Console session is read-only" }],
      });
      expect(cron.status).toBe(403);
      expect(records).toEqual([]);
    });

    it("lets the write credential past the scope gate", async () => {
      const login = await consoleLogin(WRITE_SECRET);
      expect(await login.json()).toEqual({ expiresIn: 3600, scope: "write" });
      const cookie = cookieNamed(login, "graphoria_console_session");

      // No publisher is configured, so the handler itself answers 400: the
      // request got past the 403 the read session is stopped at.
      const publish = await consolePost("queues/publish", cookie, {
        publisher: "orders",
        message: "m",
      });
      expect(publish.status).toBe(400);
      expect(await publish.json()).toEqual({ errors: [{ message: 'Unknown publisher "orders"' }] });
    });

    it("still issues a write session to the admin secret, recorded as the superset", async () => {
      const login = await consoleLogin(adminSecret());
      expect(await login.json()).toEqual({ expiresIn: 3600, scope: "write" });
      expect(records[0]).toMatchObject({
        action: "console.login",
        actor: { type: "admin_secret", scope: "all" },
      });
    });

    it("refuses a credential scoped to another surface", async () => {
      expect((await consoleLogin(AI_SECRET)).status).toBe(401);
      expect((await consoleLogin(MCP_SECRET)).status).toBe(401);
    });
  });

  describe("agent", () => {
    it("refuses the console-read credential", async () => {
      const response = await ask(READ_SECRET);
      expect(response.status).toBe(404);
      expect(records).toEqual([]);
    });

    it("accepts the agent credential and records it as scoped", async () => {
      const spy = spyOn(aiModule, "getAgent").mockReturnValue(async () => "forty-two");
      try {
        const response = await ask(AI_SECRET);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ answer: "forty-two" });

        expect(records).toEqual([
          {
            action: "admin_secret.used",
            actor: { type: "admin_secret", scope: "ai", ip: expect.any(String) },
            target: { kind: "endpoint", method: "POST", path: "/rest/ai" },
          },
          {
            action: "ai.ask",
            actor: { type: "admin_secret", sub: "ai", role: "superadmin", scope: "ai" },
            target: { kind: "ai", via: "rest" },
            prompt: "how many users?",
          },
        ]);
        expect(JSON.stringify(records)).not.toContain(AI_SECRET);
      } finally {
        spy.mockRestore();
      }
    });

    it("still accepts the admin secret, recorded as the superset", async () => {
      const spy = spyOn(aiModule, "getAgent").mockReturnValue(async () => "forty-two");
      try {
        const response = await ask(adminSecret());
        expect(response.status).toBe(200);
        expect(records[0]).toMatchObject({
          action: "admin_secret.used",
          actor: { type: "admin_secret", scope: "all" },
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("does not open the GraphQL endpoint: the agent credential runs as anonymous there", async () => {
      const response = await started.context.gql('{ ask(prompt: "x") }', undefined, {
        headers: { "x-admin-secret": AI_SECRET },
      });

      expect(response.errors?.[0]?.message).toMatch(/Cannot query field "ask"/);
      expect(records).toEqual([]);
    });
  });

  describe("mcp", () => {
    it("opens the gate to the MCP credential and records it as scoped", async () => {
      expect(await mcp(MCP_SECRET)).not.toBe(401);
      expect(records).toEqual([
        {
          action: "admin_secret.used",
          actor: { type: "admin_secret", scope: "mcp", ip: expect.any(String) },
          target: { kind: "endpoint", method: "POST", path: "/mcp" },
        },
      ]);
    });

    it("keeps the gate shut to the other scoped credentials", async () => {
      expect(await mcp(AI_SECRET)).toBe(401);
      expect(await mcp(READ_SECRET)).toBe(401);
      expect(await mcp(WRITE_SECRET)).toBe(401);
      expect(records).toEqual([]);
    });

    it("still opens the gate to the admin secret, recorded as the superset", async () => {
      expect(await mcp(adminSecret())).not.toBe(401);
      expect(records[0]).toMatchObject({ actor: { type: "admin_secret", scope: "all" } });
    });
  });
});

describe.skipIf(!integrationEnabled)("scoped credentials read as their configured role", () => {
  const ANALYST_AI_SECRET = "analyst-agent-secret";
  const ANALYST_MCP_SECRET = "analyst-mcp-secret";
  const users = fieldName(ENGINE, "app", "users");

  let started: StartedServer;
  let records: AuditEvent[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let setAuditLog: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let aiModule: any;

  beforeAll(async () => {
    const { env } = await import("../../singletons/env");
    started = await startServer({
      engine: ENGINE,
      config: {
        ai: { enabled: true, mcp: { enabled: true } },
        auth: {
          enabled: false,
          database: "",
          permissions: {
            anonymous: { tables: "ALL", storedProcedures: "ALL" },
            analyst: { tables: [users], ai: true },
          },
        },
      } as never,
      env: {
        ai: {
          ...env.ai,
          secrets: [ANALYST_AI_SECRET],
          secretRole: "analyst",
          mcp: {
            ...env.ai.mcp,
            requireAdminSecret: true,
            secrets: [ANALYST_MCP_SECRET],
            secretRole: "analyst",
          },
        },
      },
    });

    ({ setAuditLog } = await import("../../logging/audit"));
    aiModule = await import("../../singletons/ai");
  });

  afterAll(async () => {
    await started?.stop();
  });

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event: AuditEvent) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  it("asks the agent as AI_SECRET_ROLE", async () => {
    const spy = spyOn(aiModule, "getAgent").mockReturnValue(async () => "forty-two");
    try {
      const response = await started.context.rest("/ai", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-secret": ANALYST_AI_SECRET },
        body: JSON.stringify({ prompt: "how many users?" }),
      });

      expect(response.status).toBe(200);
      expect(records.find((record) => record.action === "ai.ask")).toMatchObject({
        actor: { type: "admin_secret", sub: "ai", role: "analyst", scope: "ai" },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("serves MCP as AI_MCP_SECRET_ROLE", async () => {
    const call = await callMcpTool(
      `http://localhost:${started.context.server.port}/mcp`,
      "list_entities",
      { kind: "table" },
      { "x-admin-secret": ANALYST_MCP_SECRET },
    );

    expect((call.result as { name: string }[]).map((entity) => entity.name)).toEqual([users]);
  });
});

describe.skipIf(!integrationEnabled)("boot with a scoped credential naming no role", () => {
  it("refuses to start on a ghost AI_SECRET_ROLE, and sets up no agent", async () => {
    const { env } = await import("../../singletons/env");
    const { disconnectDatabases } = await import("../../singletons/databases");
    const { getAgent, resetAI } = await import("../../singletons/ai");
    // The servers booted above set the agent up; only this boot's own is in question.
    resetAI();

    try {
      await expect(
        startServer({
          engine: ENGINE,
          skipSeed: true,
          config: { ai: { enabled: true } } as never,
          env: {
            ai: {
              ...env.ai,
              enabled: true,
              restEnabled: true,
              secrets: ["ghost-agent-secret"],
              secretRole: "ghost",
            },
          },
        }),
      ).rejects.toThrow('AI_SECRET_ROLE is "ghost", which is not a configured role');
      expect(() => getAgent()).toThrow("AI agent is not enabled");
    } finally {
      // The boot connected the pool before it failed, and nothing else closes it.
      await disconnectDatabases();
    }
  });
});

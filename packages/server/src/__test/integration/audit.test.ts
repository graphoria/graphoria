import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { AuditEvent } from "../../logging/audit";
import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * Every privileged action through the real boot path produces exactly one
 * audit record naming the actor, the action and the target, and no record
 * carries a secret. The sites that only a booted server reaches — the HTTP
 * admin-secret path, the websocket handshake, the REST agent endpoint and the
 * two login flows — are pinned here; the console, MCP and GraphQL mutation
 * sites have unit tests next to their handlers.
 *
 * PostgreSQL only: nothing here touches the query builder.
 */

const ENGINE = "pg" as const;

const USERNAME = "audit-alice";
const PASSWORD = "correct horse battery staple";
const ROLE = "user";
const CONSOLE_PATH = "/_console";

const authConfig = {
  enabled: true,
  database: "default",
  schema: "auth",
  autoCreateTables: true,
  permissions: {
    anonymous: { tables: "ALL", storedProcedures: "ALL", operations: "ALL" },
    [ROLE]: { tables: "ALL", storedProcedures: "ALL", operations: "ALL" },
  },
} as const;

const cookieNamed = (response: Response, name: string): string => {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie was set`);
  return header.split(";")[0]!;
};

describe.skipIf(!integrationEnabled)("audit log", () => {
  let started: StartedServer;
  let records: AuditEvent[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let setAuditLog: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let aiModule: any;

  const adminSecret = () => process.env["ADMIN_SECRET"]!;
  const serialized = () => JSON.stringify(records);
  const url = (path: string) => `http://localhost:${started.context.server.port}${path}`;

  beforeAll(async () => {
    started = await startServer({
      engine: ENGINE,
      config: { auth: authConfig, ai: { enabled: true } } as never,
      env: {
        console: {
          enabled: true,
          endpoint: CONSOLE_PATH,
          sessionExpiresIn: "1h",
          readSecrets: [],
          writeSecrets: [],
        },
      },
    });

    ({ setAuditLog } = await import("../../logging/audit"));
    aiModule = await import("../../singletons/ai");

    const { hashPassword } = await import("../../databases/auth/password");
    const hash = await hashPassword(PASSWORD);
    await started.context.sql(
      `INSERT INTO auth."user" (username, password, role, is_active, claims)
       VALUES ('${USERNAME}', '${hash}', '${ROLE}', TRUE, '{}')
       ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password,
                                            role = EXCLUDED.role,
                                            is_active = TRUE`,
    );
  });

  afterAll(async () => {
    await started?.stop();
  });

  beforeEach(() => {
    records = [];
    setAuditLog({ emit: (event: AuditEvent) => records.push(event) });
  });

  afterEach(() => setAuditLog(null));

  const login = async () => {
    const response = await started.context.gqlRaw(
      `mutation { auth_login(username: "${USERNAME}", password: "${PASSWORD}") { access_token } }`,
    );
    const body = (await response.json()) as { data: { auth_login: { access_token: string } } };
    return {
      token: body.data.auth_login.access_token,
      cookie: cookieNamed(response, "refresh_token"),
    };
  };

  describe("admin secret", () => {
    it("records one use per GraphQL request, naming the endpoint", async () => {
      await started.context.gql("{ __typename }", undefined, { admin: true });

      expect(records).toEqual([
        {
          action: "admin_secret.used",
          actor: { type: "admin_secret", ip: expect.any(String) },
          target: { kind: "endpoint", method: "POST", path: "/graphql" },
        },
      ]);
      expect(serialized()).not.toContain(adminSecret());
    });

    it("records nothing for a request that does not present it", async () => {
      await started.context.gql("{ __typename }");
      expect(records).toEqual([]);
    });

    it("records one use per REST request, even one that ends in a 404", async () => {
      await started.context.rest("/nothing-here", { admin: true });

      expect(records).toEqual([
        {
          action: "admin_secret.used",
          actor: { type: "admin_secret", ip: expect.any(String) },
          target: { kind: "endpoint", method: "GET", path: "/rest/nothing-here" },
        },
      ]);
    });

    it("records one use when a websocket authenticates with it", async () => {
      const client = await started.context.subscribe("subscription { nothing }", { admin: true });
      client.close();

      expect(records).toEqual([
        {
          action: "admin_secret.used",
          actor: { type: "admin_secret", ip: expect.any(String) },
          target: { kind: "websocket" },
        },
      ]);
    });
  });

  describe("login and logout", () => {
    it("records a successful login by username and role, without the password", async () => {
      await login();

      expect(records).toEqual([
        {
          action: "auth.login",
          outcome: "success",
          actor: { type: "credentials", sub: USERNAME },
          target: { kind: "auth", via: "graphql", role: ROLE },
        },
      ]);
      expect(serialized()).not.toContain(PASSWORD);
    });

    it("records a failed login with the reason and without the guess", async () => {
      await started.context.gql(
        `mutation { auth_login(username: "${USERNAME}", password: "wrong-guess") { access_token } }`,
      );

      expect(records).toEqual([
        {
          action: "auth.login",
          outcome: "failure",
          actor: { type: "credentials", sub: USERNAME },
          target: { kind: "auth", via: "graphql" },
          reason: "Invalid username or password",
        },
      ]);
      expect(serialized()).not.toContain("wrong-guess");
    });

    it("records a logout with every token it revoked", async () => {
      const { token, cookie } = await login();
      records = [];

      await started.context.gql(`mutation { auth_logout }`, undefined, { token, cookie });

      expect(records).toEqual([
        {
          action: "auth.logout",
          actor: { type: "token", sub: USERNAME, role: ROLE },
          target: {
            kind: "auth",
            via: "graphql",
            revoked: [expect.any(String), expect.any(String)],
          },
        },
      ]);
      expect(serialized()).not.toContain(token);
    });

    it("records the REST login and logout the same way", async () => {
      const response = await started.context.rest("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      const body = (await response.json()) as { data: { access_token: string } };
      const cookie = cookieNamed(response, "refresh_token");

      await started.context.rest("/auth/logout", {
        method: "POST",
        token: body.data.access_token,
        cookie,
      });

      expect(records.map((record) => record.action)).toEqual(["auth.login", "auth.logout"]);
      expect(records[0]).toMatchObject({
        outcome: "success",
        actor: { type: "credentials", sub: USERNAME },
        target: { kind: "auth", via: "rest", role: ROLE },
      });
      expect(records[1]).toMatchObject({
        actor: { type: "token", sub: USERNAME, role: ROLE },
        target: { kind: "auth", via: "rest", revoked: [expect.any(String), expect.any(String)] },
      });
      expect(serialized()).not.toContain(PASSWORD);
    });
  });

  describe("agent", () => {
    it("records an ask over REST with the prompt, after the admin-secret use", async () => {
      const spy = spyOn(aiModule, "getAgent").mockReturnValue(async () => "forty-two");
      try {
        const response = await started.context.rest("/ai", {
          method: "POST",
          admin: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "how many users?" }),
        });
        expect(await response.json()).toEqual({ answer: "forty-two" });

        expect(records.map((record) => record.action)).toEqual(["admin_secret.used", "ai.ask"]);
        expect(records[1]).toEqual({
          action: "ai.ask",
          actor: { type: "admin_secret", sub: "superadmin", role: "superadmin", scope: "all" },
          target: { kind: "ai", via: "rest" },
          prompt: "how many users?",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("console", () => {
    it("records the login and the logout of a console session", async () => {
      const login = await Bun.fetch(url(`${CONSOLE_PATH}/api/login`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: adminSecret() }),
      });
      expect(login.status).toBe(200);
      const cookie = cookieNamed(login, "graphoria_console_session");

      const logout = await Bun.fetch(url(`${CONSOLE_PATH}/api/logout`), {
        method: "POST",
        headers: { cookie },
      });
      expect(logout.status).toBe(200);

      expect(records).toEqual([
        {
          action: "console.login",
          outcome: "success",
          actor: { type: "admin_secret", scope: "all", ip: expect.any(String) },
          target: { kind: "console" },
        },
        {
          action: "console.logout",
          actor: { type: "console", ip: expect.any(String) },
          target: { kind: "console" },
        },
      ]);
      expect(serialized()).not.toContain(adminSecret());
      expect(serialized()).not.toContain(cookie.split("=")[1]);
    });
  });
});

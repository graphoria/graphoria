import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { AuditEvent } from "../../logging/audit";
import type { StartedServer } from "./harness";

import { fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { EXPECTED_COUNTS } from "./seed";

/**
 * With auth off, a bearer token is still verified when the token key is set: a
 * token issued elsewhere with the same key keeps its role.
 *
 * Without a key there is nothing to verify against, so every bearer token is
 * anonymous, while the admin secret works as before. A key is still required
 * once something signs tokens: auth or the console.
 *
 * PostgreSQL only: nothing under test here is engine-specific.
 */

const ENGINE = "pg" as const;
const ROLE = "member";

const organizations = fieldName(ENGINE, "app", "organizations");
const projects = fieldName(ENGINE, "app", "projects");

// Anonymous sees organizations only; the member role sees every table.
const authOff = {
  enabled: false,
  database: "",
  permissions: {
    anonymous: { tables: [organizations] },
    [ROLE]: { tables: "ALL", storedProcedures: "ALL" },
  },
};

const PROJECTS_QUERY = `query { ${projects} { id } }`;

/** An access token signed with the harness's JWT_SECRET, as another issuer would sign it. */
const issueMemberToken = async () => {
  const { env } = await import("../../singletons/env");
  const { createJWTService } = await import("../../authentication/jwt");
  const issuer = createJWTService(env);
  try {
    return await issuer.createToken({ sub: "external", role: ROLE }, { audience: "access" });
  } finally {
    issuer.close();
  }
};

describe.skipIf(!integrationEnabled)("bearer tokens with auth off", () => {
  describe("with the token key set", () => {
    let started: StartedServer;
    let token: string;

    beforeAll(async () => {
      started = await startServer({ engine: ENGINE, config: { auth: authOff } as never });
      token = await issueMemberToken();
    });

    afterAll(async () => {
      await started?.stop();
    });

    it("gives a token signed with the key its role", async () => {
      const response = await started.context.gql<Record<string, unknown[]>>(
        PROJECTS_QUERY,
        undefined,
        { token },
      );

      expect(response.errors).toBeUndefined();
      expect(response.data?.[projects]).toHaveLength(EXPECTED_COUNTS.projects);
    });

    it("keeps a request without a token anonymous", async () => {
      const response = await started.context.gql(PROJECTS_QUERY);

      expect(response.errors?.length).toBeGreaterThan(0);
      expect(response.data?.[projects]).toBeUndefined();
    });

    it("treats a token it cannot verify as anonymous", async () => {
      const response = await started.context.gql(PROJECTS_QUERY, undefined, {
        token: "not.a.token",
      });

      expect(response.errors?.length).toBeGreaterThan(0);
    });
  });

  const noKey = { jwt: { secrets: [], expiresIn: "5m", rtExpiresIn: "7d" } };

  describe("without a token key", () => {
    let started: StartedServer;
    let token: string;
    let records: AuditEvent[];
    // oxlint-disable-next-line typescript/no-explicit-any
    let setAuditLog: any;

    beforeAll(async () => {
      started = await startServer({
        engine: ENGINE,
        skipSeed: true,
        config: { auth: authOff } as never,
        env: noKey,
      });
      ({ setAuditLog } = await import("../../logging/audit"));
      token = await issueMemberToken();
    });

    beforeEach(() => {
      records = [];
      setAuditLog({ emit: (event: AuditEvent) => records.push(event) });
    });

    afterEach(() => setAuditLog(null));

    afterAll(async () => {
      await started?.stop();
    });

    it("boots, and treats a bearer token as anonymous", async () => {
      const response = await started.context.gql(PROJECTS_QUERY, undefined, { token });

      expect(response.errors?.length).toBeGreaterThan(0);
      expect(response.data?.[projects]).toBeUndefined();
    });

    it("still accepts the admin secret over HTTP", async () => {
      const response = await started.context.gql<Record<string, unknown[]>>(
        PROJECTS_QUERY,
        undefined,
        { admin: true },
      );

      expect(response.errors).toBeUndefined();
      expect(response.data?.[projects]).toHaveLength(EXPECTED_COUNTS.projects);
    });

    it("still accepts the admin secret on a websocket", async () => {
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

    it("acknowledges a websocket that brings only a bearer token", async () => {
      const client = await started.context.subscribe("subscription { nothing }", { token });
      client.close();

      expect(records).toEqual([]);
    });
  });

  describe("boot without a token key", () => {
    it("fails with auth on", async () => {
      await expect(
        startServer({
          engine: ENGINE,
          skipSeed: true,
          config: {
            auth: {
              ...authOff,
              enabled: true,
              database: "default",
              schema: "auth",
              autoCreateTables: true,
            },
          } as never,
          env: noKey,
        }),
      ).rejects.toThrow("JWT_SECRET");
    });

    it("fails with the console on", async () => {
      const { env } = await import("../../singletons/env");

      await expect(
        startServer({
          engine: ENGINE,
          skipSeed: true,
          config: { auth: authOff } as never,
          env: { ...noKey, console: { ...env.console, enabled: true } },
        }),
      ).rejects.toThrow("JWT_SECRET");
    });
  });
});

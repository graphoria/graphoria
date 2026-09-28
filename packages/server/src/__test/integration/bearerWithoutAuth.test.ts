import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { fieldName } from "./config";
import { integrationEnabled, startServer } from "./harness";
import { EXPECTED_COUNTS } from "./seed";

/**
 * With auth off, a bearer token is still verified when the token key is set: a
 * token issued elsewhere with the same key keeps its role.
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
});

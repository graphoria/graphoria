import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeys } from "paseto-ts/v4";

import type { TokenStrategy } from "../../authentication/types";
import type { Env } from "../../types/env";
import type { RequestOptions, StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * Secret rotation, end to end: a token issued by a server running the old key
 * must keep working on a server running `new,old`, with no failed request in
 * between, and a token the rotated server issues must still work once the old
 * key is dropped. Each step is a fresh boot, because that is how a rotation
 * reaches a deployment — the env is read once at startup.
 *
 * PostgreSQL only: nothing under test here is engine-specific.
 */

const ENGINE = "pg" as const;

const USERNAME = "rotation-alice";
const PASSWORD = "correct horse battery staple";
const ROLE = "user";

/** Requests to fire at the rotated server with the pre-rotation token. */
const REQUESTS_UNDER_OLD_TOKEN = 25;

const STRATEGIES = ["jwt", "paseto_local", "paseto_public"] as const;

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

const OLD_JWT_SECRET = "rotation-jwt-secret-old-rotation-jwt-secret-old";
const NEW_JWT_SECRET = "rotation-jwt-secret-new-rotation-jwt-secret-new";
const OLD_ADMIN_SECRET = "rotation-admin-secret-old";
const NEW_ADMIN_SECRET = "rotation-admin-secret-new";

const oldLocalKey = generateKeys("local") as string;
const newLocalKey = generateKeys("local") as string;
const oldPublicKeys = generateKeys("public") as { secretKey: string; publicKey: string };
const newPublicKeys = generateKeys("public") as { secretKey: string; publicKey: string };

type RotationStep = "old" | "new,old" | "new";

/** The env override that puts `strategy` at a given step of the rotation. */
const keysAt = (strategy: TokenStrategy, step: RotationStep): Partial<Env> => {
  const pick = <T>(current: T, previous: T): T[] =>
    step === "old" ? [previous] : step === "new" ? [current] : [current, previous];

  switch (strategy) {
    case "jwt":
      return {
        jwt: { secrets: pick(NEW_JWT_SECRET, OLD_JWT_SECRET), expiresIn: "5m", rtExpiresIn: "7d" },
      };
    case "paseto_local":
      return {
        paseto: { localKeys: pick(newLocalKey, oldLocalKey), secretKey: "", publicKeys: [] },
      };
    case "paseto_public":
      return {
        paseto: {
          localKeys: [],
          secretKey: step === "old" ? oldPublicKeys.secretKey : newPublicKeys.secretKey,
          publicKeys: pick(newPublicKeys.publicKey, oldPublicKeys.publicKey),
        },
      };
  }
};

const refreshCookie = (response: Response): string => {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("refresh_token="));

  if (!header) throw new Error("no refresh_token cookie was set");

  return header.split(";")[0]!;
};

type Issued = { access_token: string; cookie: string };
type Session = { username: string; role: string };

const login = async (server: StartedServer): Promise<Issued> => {
  const response = await server.context.gqlRaw(
    `mutation { auth_login(username: "${USERNAME}", password: "${PASSWORD}") { access_token } }`,
  );
  const body = (await response.json()) as {
    data?: { auth_login: { access_token: string } };
    errors?: { message: string }[];
  };

  expect(body.errors ?? []).toEqual([]);

  return { access_token: body.data!.auth_login.access_token, cookie: refreshCookie(response) };
};

const whoami = async (server: StartedServer, options: RequestOptions = {}): Promise<Session> => {
  const response = await server.context.gql<{ auth_me: Session }>(
    `query { auth_me { username role } }`,
    undefined,
    options,
  );

  expect(response.errors ?? []).toEqual([]);

  return response.data!.auth_me;
};

const refresh = async (server: StartedServer, cookie: string): Promise<Issued> => {
  const response = await server.context.gqlRaw(
    `mutation { auth_refresh { access_token } }`,
    undefined,
    { cookie },
  );
  const body = (await response.json()) as {
    data?: { auth_refresh: { access_token: string } };
    errors?: { message: string }[];
  };

  expect(body.errors ?? []).toEqual([]);

  return { access_token: body.data!.auth_refresh.access_token, cookie: refreshCookie(response) };
};

const boot = (strategy: TokenStrategy, step: RotationStep, skipSeed = true) =>
  startServer({
    engine: ENGINE,
    skipSeed,
    config: { tokenStrategy: strategy, auth: authConfig } as never,
    env: keysAt(strategy, step),
  });

describe.skipIf(!integrationEnabled)("secret rotation", () => {
  const user = { username: USERNAME, role: ROLE };
  const anonymous = { username: "anonymous", role: "anonymous" };

  for (const [index, strategy] of STRATEGIES.entries()) {
    describe(`strategy · ${strategy}`, () => {
      /** Issued by a server that only knows the old key. */
      let underOld: Issued;
      /** Issued by the server running `new,old`, so signed with the new key. */
      let underRotated: Issued;

      beforeAll(async () => {
        const before = await boot(strategy, "old", index > 0);

        try {
          const { hashPassword } = await import("../../databases/auth/password");
          const hash = await hashPassword(PASSWORD);

          await before.context.sql(
            `INSERT INTO auth."user" (username, password, role, is_active, claims)
             VALUES ('${USERNAME}', '${hash}', '${ROLE}', TRUE, '{}')
             ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password,
                                                  role = EXCLUDED.role,
                                                  is_active = TRUE`,
          );

          underOld = await login(before);
        } finally {
          await before.stop();
        }
      });

      it("serves every request made with a token issued under the previous key", async () => {
        const rotated = await boot(strategy, "new,old");

        try {
          const sessions = await Promise.all(
            Array.from({ length: REQUESTS_UNDER_OLD_TOKEN }, () =>
              whoami(rotated, { token: underOld.access_token }),
            ),
          );

          const failed = sessions.filter((session) => session.role !== ROLE);

          expect(failed).toEqual([]);
          expect(sessions).toHaveLength(REQUESTS_UNDER_OLD_TOKEN);
        } finally {
          await rotated.stop();
        }
      });

      it("refreshes a refresh token issued under the previous key", async () => {
        const rotated = await boot(strategy, "new,old");

        try {
          const refreshed = await refresh(rotated, underOld.cookie);

          expect(await whoami(rotated, { token: refreshed.access_token })).toEqual(user);

          underRotated = await login(rotated);
        } finally {
          await rotated.stop();
        }
      });

      it("issues tokens under the new key, so they survive dropping the old one", async () => {
        const after = await boot(strategy, "new");

        try {
          expect(await whoami(after, { token: underRotated.access_token })).toEqual(user);
          expect(await whoami(after, { token: underOld.access_token })).toEqual(anonymous);
        } finally {
          await after.stop();
        }
      });
    });
  }

  describe("admin secret", () => {
    let rotated: StartedServer;

    beforeAll(async () => {
      rotated = await startServer({
        engine: ENGINE,
        skipSeed: true,
        config: { auth: authConfig } as never,
        env: { admin: { secrets: [NEW_ADMIN_SECRET, OLD_ADMIN_SECRET], header: "x-admin-secret" } },
      });
    });

    afterAll(async () => {
      await rotated?.stop();
    });

    const asAdmin = (secret: string) => whoami(rotated, { headers: { "x-admin-secret": secret } });

    it("resolves the previous admin secret to superadmin", async () => {
      expect(await asAdmin(OLD_ADMIN_SECRET)).toEqual({
        username: "superadmin",
        role: "superadmin",
      });
    });

    it("resolves the current admin secret to superadmin", async () => {
      expect(await asAdmin(NEW_ADMIN_SECRET)).toEqual({
        username: "superadmin",
        role: "superadmin",
      });
    });

    it("resolves any other value to anonymous", async () => {
      expect(await asAdmin("rotation-admin-secret-wrong")).toEqual({
        username: "anonymous",
        role: "anonymous",
      });
    });
  });
});

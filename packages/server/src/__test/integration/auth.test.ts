import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { TokenStrategy } from "../../authentication/types";
import type { IntegrationContext, StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";

/**
 * Task 1.5 of the hardening plan: the auth and cache paths against real Redis,
 * not a Map-backed fake. The token repository is the only place Graphoria stores
 * state outside the database, and every claim that rests on it — refresh
 * rotation, replay detection, logout, fail-closed behaviour when Redis is gone —
 * was previously asserted only against an injected double.
 *
 * PostgreSQL only. What is under test here is the token service, the Redis
 * repository and the cache store, none of which are engine-specific; the login
 * SQL itself has per-engine unit tests in databases/engines/*\/auth.test.ts.
 */

const ENGINE = "pg" as const;

const USERNAME = "integration-alice";
const PASSWORD = "correct horse battery staple";
const ROLE = "user";

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

/** Reads the `refresh_token` cookie out of a response's Set-Cookie headers. */
const refreshCookie = (response: Response): string => {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("refresh_token="));

  if (!header) throw new Error("no refresh_token cookie was set");

  return header.split(";")[0]!;
};

type AuthToken = { access_token: string; expires_in: number; role: string };

describe.skipIf(!integrationEnabled)("auth · redis", () => {
  for (const [index, strategy] of STRATEGIES.entries()) {
    describe(`strategy · ${strategy}`, () => {
      let started: StartedServer;
      let gql: IntegrationContext["gql"];
      let gqlRaw: IntegrationContext["gqlRaw"];

      beforeAll(async () => {
        started = await startServer({
          engine: ENGINE,
          // The first strategy seeds; the rest reuse the same database, because
          // the auth user lives outside the seeded schemas anyway.
          skipSeed: index > 0,
          config: { tokenStrategy: strategy as TokenStrategy, auth: authConfig } as never,
        });

        gql = started.context.gql;
        gqlRaw = started.context.gqlRaw;

        const { hashPassword } = await import("../../databases/auth/password");
        const hash = await hashPassword(PASSWORD);

        await started.context.sql(
          `INSERT INTO auth."user" (username, password, role, is_active, claims)
           VALUES ('${USERNAME}', '${hash}', '${ROLE}', TRUE, '{"organizationId": 1}')
           ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password,
                                                role = EXCLUDED.role,
                                                is_active = TRUE`,
        );
      });

      afterAll(async () => {
        await started?.stop();
      });

      const login = async () => {
        const response = await gqlRaw(
          `mutation { auth_login(username: "${USERNAME}", password: "${PASSWORD}") { access_token expires_in role } }`,
        );

        const body = (await response.json()) as {
          data?: { auth_login: AuthToken };
          errors?: { message: string }[];
        };

        expect(body.errors ?? []).toEqual([]);

        return { token: body.data!.auth_login, cookie: refreshCookie(response) };
      };

      const whoami = async (options: { token?: string } = {}) => {
        const response = await gql<{ auth_me: { username: string; role: string } | null }>(
          `query { auth_me { username role } }`,
          undefined,
          options,
        );

        expect(response.errors ?? []).toEqual([]);

        return response.data!.auth_me;
      };

      it("issues a token pair for valid credentials", async () => {
        const { token, cookie } = await login();

        expect(token.access_token.length).toBeGreaterThan(0);
        expect(token.role).toBe(ROLE);
        expect(token.expires_in).toBeGreaterThan(0);
        expect(cookie).toStartWith("refresh_token=");
      });

      it("rejects a wrong password", async () => {
        const response = await gql(
          `mutation { auth_login(username: "${USERNAME}", password: "wrong") { access_token } }`,
        );

        expect(response.errors?.[0]?.message).toContain("Invalid username or password");
      });

      it("resolves the access token to its own session", async () => {
        const { token } = await login();

        expect(await whoami({ token: token.access_token })).toEqual({
          username: USERNAME,
          role: ROLE,
        });
      });

      it("resolves a request with no token to the anonymous session", async () => {
        expect(await whoami()).toEqual({ username: "anonymous", role: "anonymous" });
      });

      it("refreshes into a new token pair", async () => {
        const { cookie } = await login();

        const response = await gqlRaw(
          `mutation { auth_refresh { access_token expires_in role } }`,
          undefined,
          { cookie },
        );

        const body = (await response.json()) as { data?: { auth_refresh: AuthToken } };
        const refreshed = body.data!.auth_refresh;

        expect(refreshed.role).toBe(ROLE);
        expect(refreshCookie(response)).not.toBe(cookie);
        expect(await whoami({ token: refreshed.access_token })).toEqual({
          username: USERNAME,
          role: ROLE,
        });
      });

      it("detects refresh token replay", async () => {
        const { cookie } = await login();

        const first = await gql(`mutation { auth_refresh { access_token } }`, undefined, {
          cookie,
        });
        expect(first.errors ?? []).toEqual([]);

        const replay = await gql(`mutation { auth_refresh { access_token } }`, undefined, {
          cookie,
        });

        expect(replay.errors?.[0]?.message).toContain("Token reuse detected");
      });

      it("downgrades the access token to anonymous after logout", async () => {
        const { token, cookie } = await login();

        const loggedOut = await gql<{ auth_logout: boolean }>(
          `mutation { auth_logout }`,
          undefined,
          { token: token.access_token, cookie },
        );

        expect(loggedOut.errors ?? []).toEqual([]);
        expect(loggedOut.data?.auth_logout).toBe(true);

        expect(await whoami({ token: token.access_token })).toEqual({
          username: "anonymous",
          role: "anonymous",
        });
      });

      it("refuses to refresh with a cookie revoked by logout", async () => {
        const { token, cookie } = await login();

        await gql(`mutation { auth_logout }`, undefined, { token: token.access_token, cookie });

        const refreshed = await gql(`mutation { auth_refresh { access_token } }`, undefined, {
          cookie,
        });

        expect(refreshed.errors?.[0]?.message).toBeDefined();
      });
    });
  }

  describe("fail-closed when Redis is unreachable", () => {
    /**
     * A real Bun RedisClient pointed at a closed port, rather than stopping the
     * compose container: the failure the code has to survive is a command that
     * cannot reach Redis, and a dead port produces exactly that without making
     * the rest of the suite order-dependent on a container restart.
     */
    const deadRepository = async () => {
      const { RedisClient } = await import("bun");
      const { createTokenRepositoryWithClient } =
        await import("../../authentication/tokenRepository");

      return createTokenRepositoryWithClient(
        new RedisClient("redis://127.0.0.1:1", {
          connectionTimeout: 250,
          autoReconnect: false,
        }) as never,
      );
    };

    it("reports an unknown JTI as used and as revoked", async () => {
      const repository = await deadRepository();

      expect(await repository.isTokenUsed(crypto.randomUUID())).toBe(true);
      expect(await repository.isRevoked(crypto.randomUUID())).toBe(true);
    });

    it("refuses to refresh rather than issuing a pair it cannot track", async () => {
      const { env } = await import("../../singletons/env");
      const { createJWTService } = await import("../../authentication/jwt");

      const service = createJWTService(env, await deadRepository());
      const pair = await service.createTokenPair({ sub: USERNAME, role: ROLE, claims: {} });

      await expect(service.refreshAccessToken(pair.refresh_token)).rejects.toThrow(
        /revoked|reuse/i,
      );
    });

    it("resolves a well-formed access token to anonymous", async () => {
      const { env } = await import("../../singletons/env");
      const { createJWTService } = await import("../../authentication/jwt");

      const service = createJWTService(env, await deadRepository());
      const pair = await service.createTokenPair({ sub: USERNAME, role: ROLE, claims: {} });

      expect(await service.verifyTokenAndGetSession(`Bearer ${pair.access_token}`, null)).toEqual({
        sub: "anonymous",
        role: "anonymous",
      });
    });
  });

  describe("cache · redis", () => {
    let started: StartedServer;

    const OPERATION = "cachedTasks";

    beforeAll(async () => {
      started = await startServer({
        engine: ENGINE,
        skipSeed: true,
        config: {
          // `operations` defaults to [] per role, so the route is filtered out
          // of the anonymous schema unless the permission is spelled out.
          auth: {
            enabled: false,
            database: "",
            permissions: {
              anonymous: { tables: "ALL", storedProcedures: "ALL", operations: "ALL" },
            },
          },
          operations: {
            [OPERATION]: {
              query: `query { app_tasks(limit: 1, orderBy: { id: ASC }) { id title } }`,
              rest: { path: "/cached-tasks", method: "GET" },
              cache: { ttl: 60_000 },
            },
          },
        } as never,
      });
    });

    afterAll(async () => {
      await started?.stop();
    });

    const read = async () => {
      const response = await started.context.rest("/cached-tasks");
      const body = (await response.json()) as {
        data: { app_tasks: { id: number; title: string }[] };
      };
      return body.data.app_tasks[0]!;
    };

    it("serves the second read from Redis and drops it on invalidation", async () => {
      const { InvalidationHelper } = await import("../../singletons/cache");

      const original = await read();
      expect(original.title.length).toBeGreaterThan(0);

      await started.context.sql(
        `UPDATE app.tasks SET title = 'cache-probe' WHERE id = ${original.id}`,
      );

      expect((await read()).title).toBe(original.title);

      expect(await InvalidationHelper.invalidate(OPERATION)).toBe(true);

      expect((await read()).title).toBe("cache-probe");

      await started.context.sql(
        `UPDATE app.tasks SET title = '${original.title.replaceAll("'", "''")}' WHERE id = ${original.id}`,
      );
    });
  });
});

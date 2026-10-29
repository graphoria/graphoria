import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { DatabaseType } from "../../types/configuration";
import type { StartedServer } from "./harness";

import { ENGINES } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * A user made in the console logs in on every engine, and a taken username is
 * named as such. Each driver reports the primary-key violation its own way, so
 * only a real one proves the mapping in databases/engines/*\/auth.ts.
 */

const CONSOLE_PATH = "/_console";
const WRITE_SECRET = "console-users-write-secret";
const USERNAME = "console-it-ada";
const PASSWORD = "correct horse battery staple";
const ROLE = "editor";

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

/** `auth."user"` spelled for `engine`. The auth schema is a database on MySQL. */
const authUserTable = (engine: DatabaseType) =>
  engine === "mysql" ? "`auth`.`user`" : engine === "mssql" ? "auth.[user]" : 'auth."user"';

const cookieNamed = (response: Response, name: string): string => {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie was set`);
  return header.split(";")[0]!;
};

describe.skipIf(!integrationEnabled)("console users", () => {
  for (const engine of ENGINES) {
    describe(engine, () => {
      let started: StartedServer;
      let cookie: string;

      const url = (path: string) => `http://localhost:${started.context.server.port}${path}`;
      const createUser = (body: object) =>
        Bun.fetch(url(`${CONSOLE_PATH}/api/users`), {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });

      const listUsers = async (query: string) => {
        const response = await Bun.fetch(url(`${CONSOLE_PATH}/api/users${query}`), {
          headers: { cookie },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { users: unknown[]; total: number };
      };

      beforeAll(async () => {
        started = await startServer({
          engine,
          config: { auth: authConfig } as never,
          env: {
            console: {
              enabled: true,
              endpoint: CONSOLE_PATH,
              sessionExpiresIn: "1h",
              readSecrets: [],
              writeSecrets: [WRITE_SECRET],
            },
          },
        });
        // A rerun against the same stack finds the user an earlier run made.
        await started.context.sql(
          `DELETE FROM ${authUserTable(engine)} WHERE username = '${USERNAME}'`,
        );

        const login = await Bun.fetch(url(`${CONSOLE_PATH}/api/login`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: WRITE_SECRET }),
        });
        cookie = cookieNamed(login, "graphoria_console_session");
      });

      afterAll(async () => {
        await started?.stop();
      });

      it("creates a user who logs in with its role and keeps its claims", async () => {
        const created = await createUser({
          username: USERNAME,
          password: PASSWORD,
          role: ROLE,
          claims: { organizationId: 7 },
        });
        expect(created.status).toBe(200);

        const login = await started.context.rest("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        });
        expect(login.status).toBe(200);
        const { data } = (await login.json()) as { data: { access_token: string } };

        const me = await started.context.gql<{
          auth_me: { username: string; role: string } | null;
        }>("query { auth_me { username role } }", undefined, { token: data.access_token });
        expect(me.data?.auth_me).toEqual({ username: USERNAME, role: ROLE });

        const [row] = await started.context.sql<{ claims: unknown }>(
          `SELECT claims FROM ${authUserTable(engine)} WHERE username = '${USERNAME}'`,
        );
        const claims = typeof row?.claims === "string" ? JSON.parse(row.claims) : row?.claims;
        expect(claims).toEqual({ organizationId: 7 });
      });

      it("names the username a second create finds taken", async () => {
        const again = await createUser({ username: USERNAME, password: PASSWORD, role: ROLE });

        expect(again.status).toBe(409);
        expect(await again.json()).toEqual({
          errors: [{ message: `User "${USERNAME}" already exists` }],
        });
      });

      it("lists the user and a deactivated one, found by a search in another case", async () => {
        const table = authUserTable(engine);
        const inactive = `${USERNAME}-off`;
        await started.context.sql(`DELETE FROM ${table} WHERE username = '${inactive}'`);
        await started.context.sql(
          `INSERT INTO ${table} (username, password, role, is_active, claims)
           VALUES ('${inactive}', 'x', '${ROLE}', ${engine === "mssql" ? "0" : "FALSE"}, '{}')`,
        );

        expect(await listUsers(`?search=${USERNAME.toUpperCase()}`)).toMatchObject({
          users: [
            { username: USERNAME, role: ROLE, isActive: true },
            { username: inactive, role: ROLE, isActive: false },
          ],
          total: 2,
        });
      });

      it("filters by role, takes a search's _ literally and counts past the last page", async () => {
        expect((await listUsers(`?search=${USERNAME}&role=${ROLE}`)).total).toBe(2);
        expect(await listUsers(`?search=${USERNAME}&role=nobody`)).toMatchObject({
          users: [],
          total: 0,
        });
        expect(await listUsers(`?search=${USERNAME.replaceAll("-", "_")}`)).toMatchObject({
          users: [],
          total: 0,
        });
        expect(await listUsers(`?search=${USERNAME}&page=2`)).toMatchObject({
          users: [],
          total: 2,
        });
      });

      it("answers a page past the 32-bit offset with an empty page and the true total", async () => {
        const past = await listUsers(`?search=${USERNAME}&page=50000000`);

        expect(past.users).toEqual([]);
        expect(past.total).toBeGreaterThanOrEqual(1);
      });

      it("takes %, ! and [ literally in a search", async () => {
        const table = authUserTable(engine);
        const cases = [
          { literal: "console-it-pct%one", near: "console-it-pctXone", needle: "pct%one" },
          { literal: "console-it-bang!one", near: "console-it-bangone", needle: "bang!one" },
          { literal: "console-it-set[a]one", near: "console-it-setaone", needle: "set[a]one" },
        ];
        for (const { literal, near } of cases)
          await started.context.sql(
            `DELETE FROM ${table} WHERE username IN ('${literal}', '${near}')`,
          );
        for (const { literal, near } of cases)
          await started.context.sql(
            `INSERT INTO ${table} (username, password, role) VALUES ('${literal}', 'x', '${ROLE}'), ('${near}', 'x', '${ROLE}')`,
          );

        for (const { literal, needle } of cases)
          expect(await listUsers(`?${new URLSearchParams({ search: needle })}`)).toMatchObject({
            users: [{ username: literal, role: ROLE, isActive: true }],
            total: 1,
          });
      });
    });
  }
});

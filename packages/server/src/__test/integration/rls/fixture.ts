import type { ConfigurationInput } from "../../../config";
import type { DatabaseType } from "../../../types/configuration";
import type { IntegrationContext, StartedServer } from "../harness";

import { fieldName } from "../config";
import { startServer } from "../harness";

/**
 * Task 3.1 of the hardening plan: the multi-tenant fixture the row-level
 * security suites run against.
 *
 * The seeded schema already carries two tenants with three users each
 * (`app.organizations` 1 and 2, `app.users` 1-3 and 4-6) and rows owned by each
 * of them, so this file adds the half that was missing: auth users that can log
 * in, and a permission configuration expressing the filter patterns
 * `docs/PERMISSIONS.md` documents.
 *
 * Every assertion in `escape.test.ts` and `injection.test.ts` reduces to the
 * same question — can a caller in tenant A observe a row belonging to tenant B,
 * by any route.
 */

export const RLS_PASSWORD = "correct horse battery staple";

export type RlsUser = {
  /** Login username; also the `sub` claim, hence an email so `$session.sub` is type-correct. */
  username: string;
  /** `app.users.id`. */
  userId: number;
  /** `app.organizations.id`. */
  organizationId: number;
  /** `app.projects.id` values this user may reach, for the `in` filter pattern. */
  allowedProjects: number[];
  role: string;
};

/**
 * One user per tenant in each role under test. Tenant 1 is Acme (app.users
 * 1-3, projects 1-2, tasks 1-6); tenant 2 is Umbrella (app.users 4-6,
 * project 3, tasks 7-10).
 */
export const RLS_USERS = {
  /** Acme. Owns tasks 1 and 6. */
  ana: {
    username: "ana@acme.test",
    userId: 1,
    organizationId: 1,
    allowedProjects: [1],
    role: "user",
  },
  /** Acme. Owns tasks 2 and 3. */
  brian: {
    username: "brian@acme.test",
    userId: 2,
    organizationId: 1,
    allowedProjects: [1, 2],
    role: "user",
  },
  /** Umbrella. Owns tasks 8 and 9 — the cross-tenant counterpart to `ana`. */
  eve: {
    username: "eve@umbrella.test",
    userId: 5,
    organizationId: 2,
    allowedProjects: [3],
    role: "user",
  },
  /** Acme, but with the department-style `in` filter rather than the ownership one. */
  dept: {
    username: "dept@acme.test",
    userId: 2,
    organizationId: 1,
    allowedProjects: [1],
    role: "project_member",
  },
  /** Acme admin: whole tenant, no row filter. */
  admin: {
    username: "admin@acme.test",
    userId: 1,
    organizationId: 1,
    allowedProjects: [1, 2],
    role: "admin",
  },
  /**
   * Carries no `missingClaim` claim while the `broken` role filter references
   * one, so this pair proves the missing-session-variable path fails closed.
   */
  broken: {
    username: "broken@acme.test",
    userId: 1,
    organizationId: 1,
    allowedProjects: [1],
    role: "broken",
  },
} as const satisfies Record<string, RlsUser>;

export type RlsUserKey = keyof typeof RLS_USERS;

/**
 * Permission configuration for the roles under test, keyed by resolver name —
 * `{schema}_{table}`, which differs per engine because MySQL has no schema
 * inside a database.
 */
const permissionsFor = (engine: DatabaseType) => {
  const app = (table: string) => fieldName(engine, "app", table);

  return {
    // Deliberately narrow: anonymous sees the one table carrying no tenant
    // column at all. Anything reachable from an unauthenticated caller is the
    // widest possible blast radius, so the suite asserts the app tables are
    // absent rather than merely filtered.
    anonymous: {
      tables: { [app("tags")]: { columns: "ALL" } },
      storedProcedures: [],
      operations: [],
    },

    // The documented ownership + tenancy patterns, one per table.
    user: {
      tables: {
        [app("tasks")]: {
          columns: "ALL",
          filter: { user_id: { eq: "$session.userId" } },
        },
        [app("projects")]: {
          columns: "ALL",
          filter: { organization_id: { eq: "$session.organizationId" } },
        },
        [app("organizations")]: {
          columns: "ALL",
          filter: { id: { eq: "$session.organizationId" } },
        },
        // `is_active`, `manager_id` and `created_at` are withheld, so a filter
        // or an ordering naming one of them is a read of a column the role
        // cannot select — the boolean-oracle and ordering-leak cases.
        [app("users")]: {
          columns: ["id", "email", "display_name", "organization_id"],
          filter: { email: { eq: "$session.sub" } },
        },
        [app("tags")]: { columns: "ALL" },
        [app("task_tags")]: { columns: "ALL" },
      },
      storedProcedures: [],
      operations: [],
    },

    // The `{ in: "$session.<array claim>" }` pattern from docs/PERMISSIONS.md.
    project_member: {
      tables: {
        [app("tasks")]: {
          columns: "ALL",
          filter: { project_id: { in: "$session.allowedProjects" } },
        },
      },
      storedProcedures: [],
      operations: [],
    },

    // Whole tenant, no row filter — the control the escape tests measure
    // against, so a filtered result is never mistaken for an empty table.
    admin: {
      tables: "ALL",
      storedProcedures: "ALL",
      operations: "ALL",
    },

    // References a claim no token carries. The documented promise is a clear
    // error; the security-relevant half is that it must not degrade into an
    // unfiltered read.
    broken: {
      tables: {
        [app("tasks")]: {
          columns: "ALL",
          filter: { user_id: { eq: "$session.missingClaim" } },
        },
      },
      storedProcedures: [],
      operations: [],
    },
  };
};

export const rlsConfig = (engine: DatabaseType): Partial<ConfigurationInput> =>
  ({
    auth: {
      enabled: true,
      database: "default",
      schema: "auth",
      autoCreateTables: true,
      permissions: permissionsFor(engine),
    },
  }) as Partial<ConfigurationInput>;

/** `auth."user"` spelled for `engine`. The auth schema is a database on MySQL. */
const authUserTable = (engine: DatabaseType) =>
  engine === "mysql" ? "`auth`.`user`" : engine === "mssql" ? "auth.[user]" : 'auth."user"';

/** Claims literal for a user, as the `claims` column stores it. */
const claimsJson = (user: RlsUser) =>
  JSON.stringify({
    userId: user.userId,
    organizationId: user.organizationId,
    allowedProjects: user.allowedProjects,
  });

/**
 * Inserts every fixture user into the auth table, replacing any left by an
 * earlier run. Delete-then-insert rather than an upsert, because the three
 * engines spell upsert three different ways and the table is ours alone.
 */
const seedAuthUsers = async (context: IntegrationContext) => {
  const { hashPassword } = await import("../../../databases/auth/password");
  // One hash for every user: argon2id is deliberately slow, and the password is
  // shared, so hashing per user would cost six derivations per engine for no
  // added coverage.
  const hash = await hashPassword(RLS_PASSWORD);
  const table = authUserTable(context.engine);
  const users = Object.values(RLS_USERS);

  const usernames = users.map((user) => `'${user.username}'`).join(", ");
  await context.sql(`DELETE FROM ${table} WHERE username IN (${usernames})`);

  const activeTrue = context.engine === "mssql" ? "1" : "TRUE";

  for (const user of users) {
    await context.sql(
      `INSERT INTO ${table} (username, password, role, is_active, claims)
       VALUES ('${user.username}', '${hash}', '${user.role}', ${activeTrue}, '${claimsJson(user)}')`,
    );
  }
};

export type RlsContext = IntegrationContext & {
  /** Access token for a fixture user, logged in through the real auth mutation. */
  tokenFor: (key: RlsUserKey) => Promise<string>;
};

export type StartedRls = { context: RlsContext; stop: () => Promise<void> };

/**
 * Boots a server for `engine` with the RLS permission config, seeds the auth
 * users, and hands back a context that can mint a token per fixture user.
 *
 * Tokens are cached for the lifetime of the server: a login is a password
 * verification plus a token signature, and the suites ask for the same handful
 * of users hundreds of times.
 */
export const startRlsServer = async (engine: DatabaseType): Promise<StartedRls> => {
  const started: StartedServer = await startServer({ engine, config: rlsConfig(engine) });

  await seedAuthUsers(started.context);

  const tokens = new Map<RlsUserKey, string>();

  const tokenFor = async (key: RlsUserKey) => {
    const cached = tokens.get(key);
    if (cached) return cached;

    const user = RLS_USERS[key];
    const response = await started.context.gql<{
      auth_login: { access_token: string; role: string };
    }>(
      `mutation Login($username: String!, $password: String!) {
         auth_login(username: $username, password: $password) { access_token role }
       }`,
      { username: user.username, password: RLS_PASSWORD },
    );

    const token = response.data?.auth_login?.access_token;

    if (!token) {
      throw new Error(
        `login failed for ${user.username}: ${JSON.stringify(response.errors ?? response)}`,
      );
    }

    if (response.data?.auth_login?.role !== user.role) {
      throw new Error(
        `${user.username} logged in as ${response.data?.auth_login?.role}, expected ${user.role}`,
      );
    }

    tokens.set(key, token);
    return token;
  };

  return {
    context: { ...started.context, tokenFor },
    stop: started.stop,
  };
};

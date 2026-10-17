import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * SUPERADMIN_ROLE names the full-access role, whatever the name: the admin
 * secret reads as it, and the in-process engine runs as it by default.
 */

const ADMIN_SECRET = "superadmin-role-test";
const QUERY = "{ main_items(orderBy: [{ id: ASC }]) { id } }";
const ROWS = { main_items: [{ id: 1 }, { id: 2 }] };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-superadmin-role-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run("CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1), (2);");
  seed.close();
});

afterEach(async () => {
  const { disconnectDatabases } = await import("../singletons/databases");
  const { setCronJobs } = await import("../singletons/cron");
  const { setQueueManager } = await import("../singletons/queues");

  await disconnectDatabases();
  setCronJobs(null);
  setQueueManager(undefined);
  await rm(dir, { recursive: true, force: true });
});

// A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
const bootOptions = async (
  role: string,
  permissions: Record<string, object> = {},
  filename = join(dir, "app.db"),
) => {
  const { env } = await import("../singletons/env");

  return {
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    admin: { ...env.admin, secrets: [ADMIN_SECRET] },
    superadmin: { role },
    configuration: {
      name: "superadmin-role-test",
      version: "1.0.0",
      databases: [{ name: "default", enabled: true, type: "sqlite", connection: { filename } }],
      auth: { enabled: false, database: "default", permissions },
    } as never,
  };
};

describe("SUPERADMIN_ROLE", () => {
  it.each(["superadmin", "root"])(
    "builds the full-access role under its name (%s)",
    async (role) => {
      const { createGraphQLEngine } = await import("../index");
      const engine = await createGraphQLEngine(await bootOptions(role));

      expect([...engine.roles].sort()).toEqual(["anonymous", role].sort());
      expect(await engine.execute(QUERY, {}, { role })).toEqual({ data: ROWS });
    },
  );

  // The route is called directly: the test preload replaces the global Response,
  // which Bun.serve then refuses.
  it.each(["superadmin", "root"])("reads the admin secret as %s on /graphql", async (role) => {
    const { createHandlers } = await import("../index");
    const options = await bootOptions(role);
    const { serverHandlers, prefixes } = await createHandlers(options);
    const graphql = serverHandlers.routes[prefixes.graphql] as {
      POST: (req: Request) => Promise<Response>;
    };

    const response = await graphql.POST(
      new Request(`http://localhost${prefixes.graphql}`, {
        method: "POST",
        headers: { "content-type": "application/json", [options.admin.header]: ADMIN_SECRET },
        body: JSON.stringify({ query: QUERY }),
      }),
    );

    expect(await response.json()).toEqual({ data: ROWS });
  });

  it("replaces a permissions entry under its name with the full-access role", async () => {
    const { createGraphQLEngine } = await import("../index");
    const engine = await createGraphQLEngine(await bootOptions("root", { root: {} }));

    expect(await engine.execute(QUERY, {}, { role: "root" })).toEqual({ data: ROWS });
  });

  it("leaves the anonymous role without tables when no permissions entry names it", async () => {
    const { createGraphQLEngine } = await import("../index");
    const engine = await createGraphQLEngine(await bootOptions("root"));

    expect(await engine.execute(QUERY, {}, { role: "anonymous" })).toMatchObject({
      errors: [{ message: 'Cannot query field "main_items" on type "Query".' }],
    });
  });

  it.each(["superadmin", "root"])("runs the engine's execute as %s by default", async (role) => {
    const { createGraphQLEngine } = await import("../index");
    const engine = await createGraphQLEngine(await bootOptions(role));

    expect(await engine.execute(QUERY)).toEqual({ data: ROWS });
  });

  // A file in a directory that does not exist fails to open at once, so only a
  // check that runs before the connect can answer.
  it.each(["createHandlers", "createGraphQLEngine"] as const)(
    "is refused by %s when it is also ANONYMOUS_ROLE, before any database connects",
    async (boot) => {
      const index = await import("../index");
      const options = await bootOptions("guest", {}, join(dir, "missing", "app.db"));

      await expect(index[boot]({ ...options, anonymousRole: "guest" })).rejects.toThrow(
        'SUPERADMIN_ROLE and ANONYMOUS_ROLE are both "guest"',
      );
    },
  );
});

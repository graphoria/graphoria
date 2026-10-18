import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * Root meta fields through the boot the server runs: graphql-js answers them
 * from each role's own schema, beside the fields SQL answers. The anonymous role
 * sees `items` and not `secrets`.
 */

const ITEMS = [{ id: 1 }, { id: 2 }];
const ITEMS_QUERY = "main_items(orderBy: [{ id: ASC }]) { id }";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-meta-fields-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run(
    "CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1), (2);" +
      "CREATE TABLE secrets (id INTEGER PRIMARY KEY); INSERT INTO secrets VALUES (7);",
  );
  seed.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
const bootOptions = async () => {
  const { env } = await import("../../singletons/env");

  return {
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: {
      name: "meta-fields-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename: join(dir, "app.db") },
        },
      ],
      auth: {
        enabled: false,
        database: "default",
        permissions: { anonymous: { tables: ["main_items"], operations: "ALL" } },
      },
      operations: {
        // The quickstart's health check.
        health: {
          query: "query { __typename }",
          description: "Health check",
          rest: { path: "/health", method: "GET" },
        },
      },
    } as never,
  };
};

describe("execute", () => {
  let engine: Awaited<ReturnType<typeof import("../../index").createGraphQLEngine>>;

  beforeAll(async () => {
    const { createGraphQLEngine } = await import("../../index");
    engine = await createGraphQLEngine(await bootOptions());
  });

  afterAll(async () => {
    await engine.close();
  });

  it("answers a root __typename with the root type's name", async () => {
    expect(await engine.execute("{ __typename }")).toEqual({ data: { __typename: "Query" } });
  });

  it("answers __type for a type the role can see", async () => {
    expect(
      await engine.execute('{ __type(name: "main_items") { name } }', {}, { role: "anonymous" }),
    ).toEqual({ data: { __type: { name: "main_items" } } });
  });

  it("answers null for a type only another role can see", async () => {
    const query = '{ __type(name: "main_secrets") { name } }';

    expect(await engine.execute(query, {}, { role: "anonymous" })).toEqual({
      data: { __type: null },
    });
    expect(await engine.execute(query)).toEqual({ data: { __type: { name: "main_secrets" } } });
  });

  it("answers meta fields beside the fields SQL answers", async () => {
    expect(await engine.execute(`{ __typename ${ITEMS_QUERY} }`)).toEqual({
      data: { __typename: "Query", main_items: ITEMS },
    });
  });
});

// The routes are called directly: the test preload replaces the global Response,
// which Bun.serve then refuses.
describe("over HTTP", () => {
  let routes: Record<string, unknown>;
  let prefixes: { graphql: string; rest: string };

  beforeAll(async () => {
    const { createHandlers } = await import("../../index");
    const handlers = await createHandlers(await bootOptions());
    routes = handlers.serverHandlers.routes;
    prefixes = handlers.prefixes;
  });

  afterAll(async () => {
    const { disconnectDatabases } = await import("../../singletons/databases");
    const { setCronJobs } = await import("../../singletons/cron");
    const { setQueueManager } = await import("../../singletons/queues");

    await disconnectDatabases();
    setCronJobs(null);
    setQueueManager(undefined);
  });

  it("answers the quickstart's health check", async () => {
    const rest = routes[`${prefixes.rest}/*`] as (req: Request) => Promise<Response>;

    const response = await rest(new Request(`http://localhost${prefixes.rest}/health`));

    expect(await response.json()).toEqual({ data: { __typename: "Query" } });
  });
});

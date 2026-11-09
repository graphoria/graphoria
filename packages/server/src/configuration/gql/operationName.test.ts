import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * `operationName` on the `/graphql` route, through the boot the server runs.
 */

const DOCUMENT = "query A { first: __typename } query B { second: __typename }";

let dir: string;
let post: (body: unknown) => Promise<Response>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-operation-name-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run("CREATE TABLE items (id INTEGER PRIMARY KEY);");
  seed.close();

  const { createHandlers } = await import("../../index");
  const { env } = await import("../../singletons/env");

  const handlers = await createHandlers({
    dbConnectRetryMs: 0,
    // A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: {
      name: "operation-name-test",
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
        permissions: { anonymous: { tables: "ALL" } },
      },
    } as never,
  });

  const graphql = handlers.serverHandlers.routes[handlers.prefixes.graphql] as unknown as {
    POST: (req: Request) => Promise<Response>;
  };
  post = (body) =>
    graphql.POST(
      new Request(`http://localhost${handlers.prefixes.graphql}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
});

afterAll(async () => {
  const { disconnectDatabases } = await import("../../singletons/databases");
  const { setCronJobs } = await import("../../singletons/cron");
  const { setQueueManager } = await import("../../singletons/queues");

  await disconnectDatabases();
  setCronJobs(null);
  setQueueManager(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("operationName on /graphql", () => {
  it("runs the operation it names", async () => {
    const response = await post({ query: DOCUMENT, operationName: "B" });

    expect(await response.json()).toEqual({ data: { second: "Query" } });
  });

  it.each([
    ["absent", {}],
    ["null, as clients send for an anonymous operation", { operationName: null }],
  ])("runs the first operation when it is %s", async (_case, extra) => {
    const response = await post({ query: DOCUMENT, ...extra });

    expect(await response.json()).toEqual({ data: { first: "Query" } });
  });

  it("answers 400 for a name the document does not hold", async () => {
    const response = await post({ query: DOCUMENT, operationName: "C" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: [{ message: 'Unknown operation named "C".' }],
    });
  });
});

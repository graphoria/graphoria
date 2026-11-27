import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigurationFn } from "../../config";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * An operation's REST route whose `query` calls another operation's GraphQL
 * mutation field: graphql-js coerces the document's variables (`Variable "$id" has
 * invalid value …`), so a path parameter the route declares as a string no longer
 * fills an `Int!`. The route's catch answers that as a bare 400.
 */

let dir: string;
let rest: (path: string) => Promise<Response>;

const configure = (({ operation, z }) => ({
  name: "operation-variables-test",
  version: "1.0.0",
  databases: [
    {
      name: "default",
      enabled: true,
      type: "sqlite" as const,
      connection: { filename: join(dir, "app.db") },
    },
  ],
  auth: {
    enabled: false,
    database: "default",
    permissions: { anonymous: { operations: "ALL" as const } },
  },
  operations: {
    bump: operation({
      input: z.object({ n: z.number().int() }),
      output: z.object({ n: z.number().int() }),
      rest: { path: "/bump", method: "POST" },
      handler: async (_options, input) => input,
    }),
    relayText: operation({
      query: "mutation ($id: Int!) { bump(input: { n: $id }) { n } }",
      rest: { path: "/relay-text/:id", method: "GET", pathParams: z.object({ id: z.string() }) },
    }),
    relayNumber: operation({
      query: "mutation ($id: Int!) { bump(input: { n: $id }) { n } }",
      rest: {
        path: "/relay-number/:id",
        method: "GET",
        pathParams: z.object({ id: z.coerce.number() }),
      },
    }),
  },
})) satisfies ConfigurationFn;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-operation-variables-"));
  new SQLiteDatabase(join(dir, "app.db"), { create: true }).close();

  const { createHandlers } = await import("../../index");
  const { env } = await import("../../singletons/env");

  const handlers = await createHandlers({
    dbConnectRetryMs: 0,
    // A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: configure,
  });

  const route = handlers.serverHandlers.routes[`${handlers.prefixes.rest}/*`] as unknown as (
    req: Request,
  ) => Promise<Response>;
  rest = (path) => route(new Request(`http://localhost${handlers.prefixes.rest}${path}`));
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

describe("a route's path parameter bound to an Int! variable", () => {
  it("is refused when the route declares it z.string()", async () => {
    const response = await rest("/relay-text/5");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: [{ message: "Bad request" }] });
  });

  it("answers when the route declares it z.coerce.number()", async () => {
    const response = await rest("/relay-number/5");

    expect(await response.json()).toEqual({ data: { bump: { n: 5 } } });
  });
});

import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load; JWT_SECRET too, since the
// first file to load it fixes env.jwt for every later file.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

/** GRAPHQL_ENABLED and REST_ENABLED, through the boot that mounts their routes. */

let dir: string;

// What a boot starts, which an earlier file's boot may have left behind.
const stopStarted = async () => {
  const { setCronJobs } = await import("./singletons/cron");
  const { setQueueManager } = await import("./singletons/queues");

  setCronJobs(null);
  setQueueManager(undefined);
};

beforeEach(async () => {
  await stopStarted();
  dir = await mkdtemp(join(tmpdir(), "graphoria-api-surfaces-"));
  new SQLiteDatabase(join(dir, "app.db"), { create: true }).close();
});

afterEach(async () => {
  const { disconnectDatabases } = await import("./singletons/databases");

  await disconnectDatabases();
  await stopStarted();
  await rm(dir, { recursive: true, force: true });
});

const mounted = async (options: Record<string, unknown>) => {
  const { createHandlers } = await import("./index");
  const { env } = await import("./singletons/env");

  const { serverHandlers, prefixes } = await createHandlers({
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: {
      name: "api-surfaces-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename: join(dir, "app.db") },
        },
      ],
    },
    ...options,
  });
  const { routes } = serverHandlers;

  return {
    graphql: prefixes.graphql in routes,
    graphiql: prefixes.graphiql in routes,
    rest: `${prefixes.rest}/*` in routes,
    openapi: prefixes.openapi in routes,
    scalar: prefixes.scalar in routes,
  };
};

describe("GRAPHQL_ENABLED and REST_ENABLED", () => {
  it("mount GraphQL and REST, with their playgrounds, by default", async () => {
    expect(await mounted({})).toEqual({
      graphql: true,
      graphiql: true,
      rest: true,
      openapi: true,
      scalar: true,
    });
  });

  it("GRAPHQL_ENABLED=false unmounts /graphql and GraphiQL, and leaves REST", async () => {
    expect(await mounted({ graphqlEnabled: false })).toEqual({
      graphql: false,
      graphiql: false,
      rest: true,
      openapi: true,
      scalar: true,
    });
  });

  it("REST_ENABLED=false unmounts /rest/*, the OpenAPI document and Scalar, and leaves GraphQL", async () => {
    expect(await mounted({ restEnabled: false })).toEqual({
      graphql: true,
      graphiql: true,
      rest: false,
      openapi: false,
      scalar: false,
    });
  });
});

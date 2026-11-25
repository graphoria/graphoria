import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TRPCRouterOf } from ".";
import type { ConfigurationFn } from "../config";
import type { AuditEvent } from "../logging/audit";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * The tRPC surface through the boot the server runs, called by a real
 * `@trpc/client` typed from the configuration. The client's `fetch` calls the
 * route directly: the test preload replaces the global Response, which
 * Bun.serve then refuses.
 */

const ADMIN_SECRET = "trpc-boot-test";

let dir: string;
const added: string[] = [];

const configure = (({ operation, z }) => ({
  name: "trpc-boot-test",
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
    permissions: {
      anonymous: { tables: ["main_items"], operations: ["listItems", "addItem"] },
    },
  },
  operations: {
    listItems: operation({
      query:
        "query ($minId: Int!) { main_items(where: { id: { gte: $minId } }, orderBy: [{ id: ASC }]) { id } }",
      input: z.object({ minId: z.number().default(1) }),
      output: z.object({ main_items: z.array(z.object({ id: z.number() })) }),
      rest: { path: "/items" },
    }),
    addItem: operation({
      input: z.object({ name: z.string() }),
      output: z.object({ count: z.number() }),
      rest: { path: "/items", method: "POST" },
      handler: async (_options, { name }) => ({ count: added.push(name) }),
    }),
    adminOnly: operation({
      output: z.string(),
      rest: { path: "/admin-only" },
      handler: async () => "for the superadmin role",
    }),
  },
})) satisfies ConfigurationFn;

type Router = TRPCRouterOf<typeof configure>;
type Route = (req: Request) => Promise<Response>;

// A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
const boot = async (enabled: boolean) => {
  const { createHandlers } = await import("../index");
  const { env } = await import("../singletons/env");

  return createHandlers({
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    admin: { ...env.admin, secrets: [ADMIN_SECRET] },
    // createHandlers merges its options shallowly: the whole block is passed.
    trpc: { ...env.trpc, enabled },
    configuration: configure,
  });
};

const teardown = async () => {
  const { disconnectDatabases } = await import("../singletons/databases");
  const { setCronJobs } = await import("../singletons/cron");
  const { setQueueManager } = await import("../singletons/queues");

  await disconnectDatabases();
  setCronJobs(null);
  setQueueManager(undefined);
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-trpc-boot-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run("CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1), (2), (3);");
  seed.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tRPC surface, TRPC_ENABLED on", () => {
  let route: Route;
  let endpoint: string;
  let adminHeader: string;
  let requests = 0;

  // httpBatchLink, not httpBatchStreamLink: the test preload's streams break a JSONL response.
  const clientFor = (headers: Record<string, string> = {}) =>
    createTRPCClient<Router>({
      links: [
        httpBatchLink({
          url: `http://localhost${endpoint}`,
          maxItems: 10,
          headers,
          fetch: (input, init) => {
            requests++;
            return route(new Request(input as string, init as RequestInit));
          },
        }),
      ],
    });

  beforeAll(async () => {
    const handlers = await boot(true);

    endpoint = handlers.prefixes.trpc;
    adminHeader = handlers.options.admin.header;
    route = handlers.serverHandlers.routes[`${endpoint}/*`] as unknown as Route;
  });

  afterAll(teardown);

  afterEach(async () => {
    const { setAuditLog } = await import("../logging/audit");
    setAuditLog(null);
    requests = 0;
  });

  it("mounts the surface under prefixes.trpc", () => {
    expect(endpoint).toBe("/trpc");
    expect(route).toBeTypeOf("function");
  });

  it("answers a typed query, its defaulted input left out or sent", async () => {
    const client = clientFor();

    const all: { main_items: { id: number }[] } = await client.listItems.query({});
    const fromTwo = await client.listItems.query({ minId: 2 });

    expect(all).toEqual({ main_items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(fromTwo).toEqual({ main_items: [{ id: 2 }, { id: 3 }] });
  });

  it("answers a typed mutation", async () => {
    const result: { count: number } = await clientFor().addItem.mutate({ name: "four" });

    expect(result).toEqual({ count: 1 });
    expect(added).toEqual(["four"]);
  });

  it("answers the calls of one tick as one batch", async () => {
    const client = clientFor();

    const results = await Promise.all([
      client.listItems.query({ minId: 3 }),
      client.listItems.query({ minId: 2 }),
    ]);

    expect(results).toEqual([{ main_items: [{ id: 3 }] }, { main_items: [{ id: 2 }, { id: 3 }] }]);
    expect(requests).toBe(1);
  });

  it("answers NOT_FOUND for an operation the caller's role lacks, and serves it to the admin secret", async () => {
    const anonymous = clientFor().adminOnly.query();

    expect(await anonymous.catch((error: unknown) => error)).toBeInstanceOf(TRPCClientError);
    expect(await anonymous.catch((error: TRPCClientError<Router>) => error.data?.code)).toBe(
      "NOT_FOUND",
    );
    expect(await clientFor({ [adminHeader]: ADMIN_SECRET }).adminOnly.query()).toBe(
      "for the superadmin role",
    );
  });

  it("records one admin_secret.used per request, single or batched", async () => {
    const { setAuditLog } = await import("../logging/audit");
    const events: AuditEvent[] = [];
    setAuditLog({ emit: (event) => events.push(event) });
    const client = clientFor({ [adminHeader]: ADMIN_SECRET });

    await client.adminOnly.query();
    expect(events.map((event) => event.action)).toEqual(["admin_secret.used"]);
    expect(events[0].target).toEqual({ kind: "endpoint", method: "GET", path: "/trpc/adminOnly" });

    events.length = 0;
    await Promise.all([client.adminOnly.query(), client.listItems.query({})]);
    expect(events.map((event) => event.action)).toEqual(["admin_secret.used"]);
  });
});

describe("tRPC surface, TRPC_ENABLED off", () => {
  afterAll(teardown);

  it("mounts no route", async () => {
    const handlers = await boot(false);

    expect(
      Object.keys(handlers.serverHandlers.routes).filter((path) => path.includes("trpc")),
    ).toEqual([]);
  });
});

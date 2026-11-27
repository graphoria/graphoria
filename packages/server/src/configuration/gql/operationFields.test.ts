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
 * Operations served as GraphQL mutations, through the boot the server runs.
 * `ana` owns items 1 and 3.
 */

let dir: string;
let engine: Awaited<ReturnType<typeof import("../../index").createGraphQLEngine>>;

const configure = (({ operation, z }) => ({
  name: "operation-fields-test",
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
      member: { tables: ["main_items"], operations: "ALL" as const },
    },
  },
  operations: {
    echo: operation({
      input: z.object({
        name: z.string().min(3),
        n: z.number().int().default(7),
        tags: z.array(z.string()).optional(),
      }),
      output: z.object({
        name: z.string(),
        n: z.number().int().optional(),
        tags: z.array(z.string()).optional(),
      }),
      rest: { path: "/echo", method: "POST" },
      handler: async (_options, input) => input,
    }),
  },
})) satisfies ConfigurationFn;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-operation-fields-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL);" +
      "INSERT INTO items VALUES (1, 'lamp', 'ana'), (2, 'desk', 'bo'), (3, 'mug', 'ana');",
  );
  seed.close();

  const { createGraphQLEngine } = await import("../../index");
  const { env } = await import("../../singletons/env");

  engine = await createGraphQLEngine({
    dbConnectRetryMs: 0,
    // A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
    queryTimeoutMs: 0,
    // The config declares no store, so an inherited one would refuse the boot.
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: configure,
  });
});

afterAll(async () => {
  await engine?.close();
  await rm(dir, { recursive: true, force: true });
});

const asAna = (query: string, variables: Record<string, unknown> = {}) =>
  engine.execute(query, variables, { role: "member", session: { sub: "ana", role: "member" } });

describe("an operation's input", () => {
  it("resolves a variable nested in a list", async () => {
    expect(
      await asAna('mutation ($t: String!) { echo(input: { name: "abc", tags: [$t] }) { tags } }', {
        t: "x",
      }),
    ).toEqual({ data: { echo: { tags: ["x"] } } });
  });

  it("comes whole from one variable", async () => {
    expect(
      await asAna("mutation ($in: echoInput!) { echo(input: $in) { name tags } }", {
        in: { name: "abc", tags: ["x", "y"] },
      }),
    ).toEqual({ data: { echo: { name: "abc", tags: ["x", "y"] } } });
  });

  it.each(["$5 off", "$session.sub", "$static_0"])(
    "keeps the literal %p as typed",
    async (name) => {
      expect(
        await asAna(`mutation { echo(input: { name: ${JSON.stringify(name)} }) { name } }`),
      ).toEqual({ data: { echo: { name } } });
    },
  );

  it('keeps a literal "$static_0" while the same document binds static_0', async () => {
    expect(
      await asAna(
        'mutation ($in: echoInput!) { a: echo(input: $in) { name } b: echo(input: { name: "$static_0" }) { name } }',
        { in: { name: "abc" } },
      ),
    ).toEqual({ data: { a: { name: "abc" }, b: { name: "$static_0" } } });
  });

  it("refuses a variable graphql-js cannot coerce", async () => {
    await expect(
      asAna("mutation ($in: echoInput!) { echo(input: $in) { name } }", { in: { name: 5 } }),
    ).rejects.toThrow('Variable "$in" has invalid value');
  });
});

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
      member: {
        tables: {
          main_items: { columns: "ALL" as const, filter: { owner: { eq: "$session.sub" } } },
        },
        operations: "ALL" as const,
      },
      // Granted operations whose reads it is not granted.
      guest: { operations: ["listItems", "countItems"] },
    },
  },
  operations: {
    echo: operation({
      input: z
        .object({
          name: z.string().min(3),
          n: z.number().int().default(7),
          tags: z.array(z.string()).optional(),
          address: z.object({ city: z.string() }).optional(),
          items: z.array(z.object({ sku: z.string() })).optional(),
        })
        .refine(async (value) => value.name !== "nobody", "nobody is reserved"),
      output: z.object({
        name: z.string(),
        n: z.number().int().optional(),
        tags: z.array(z.string()).optional(),
        address: z.object({ city: z.string() }).optional(),
        items: z.array(z.object({ sku: z.string() })).optional(),
      }),
      rest: { path: "/echo", method: "POST" },
      handler: async (_options, input) => input,
    }),
    renamed: operation({
      graphql: { name: "renamedMutation" },
      output: z.object({ ok: z.boolean() }),
      rest: { path: "/renamed", method: "POST" },
      handler: async () => ({ ok: true }),
    }),
    listItems: operation({
      query:
        "query ($minId: Int!) { main_items(where: { id: { gte: $minId } }, orderBy: [{ id: ASC }]) { id } }",
      input: z.object({ minId: z.number().int() }),
      output: z.object({ main_items: z.array(z.object({ id: z.number().int() })) }),
      rest: { path: "/items", method: "POST" },
    }),
    countItems: operation({
      output: z.object({ count: z.number().int() }),
      rest: { path: "/count-items", method: "POST" },
      handler: async ({ gqlQuery }) => {
        const { data } = await gqlQuery<{ main_items: { id: number }[] }>(
          "query { main_items { id } }",
        );
        return { count: data.main_items.length };
      },
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

const asGus = (query: string) =>
  engine.execute(query, {}, { role: "guest", session: { sub: "gus", role: "guest" } });

describe("an operation's input", () => {
  it("resolves a variable nested in a list", async () => {
    expect(
      await asAna('mutation ($t: String!) { echo(input: { name: "abc", tags: [$t] }) { tags } }', {
        t: "x",
      }),
    ).toEqual({ data: { echo: { tags: ["x"] } } });
  });

  it("takes nested objects, inline and from a variable", async () => {
    expect(
      await asAna(
        'mutation ($sku: String!) { echo(input: { name: "abc", address: { city: "Rome" }, items: [{ sku: $sku }] }) { address { city } items { sku } } }',
        { sku: "A1" },
      ),
    ).toEqual({ data: { echo: { address: { city: "Rome" }, items: [{ sku: "A1" }] } } });
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

describe("an operation renamed by graphql.name", () => {
  it("answers under its field name", async () => {
    expect(await asAna("mutation { renamedMutation { ok } }")).toEqual({
      data: { renamedMutation: { ok: true } },
    });
  });
});

describe("an operation runs as its REST route does", () => {
  it("runs a query operation's document as the caller, their row filter included", async () => {
    expect(
      await asAna("mutation { listItems(input: { minId: 1 }) { main_items { id } } }"),
    ).toEqual({ data: { listItems: { main_items: [{ id: 1 }, { id: 3 }] } } });
  });

  it("refuses a query operation to a role not granted what its document reads", async () => {
    await expect(
      asGus("mutation { listItems(input: { minId: 1 }) { main_items { id } } }"),
    ).rejects.toThrow("You are not authorized");
  });

  it("runs a handler's gqlQuery as the superadmin role", async () => {
    expect(await asGus("mutation { countItems { count } }")).toEqual({
      data: { countItems: { count: 3 } },
    });
  });
});

describe("an operation's input schema", () => {
  it("refuses input it rejects, naming the field", async () => {
    await expect(asAna('mutation { echo(input: { name: "ab" }) { name } }')).rejects.toThrow(
      'Invalid input for "echo": name: Too small: expected string to have >=3 characters',
    );
  });

  it("names the input itself for an async refinement of the whole object", async () => {
    await expect(asAna('mutation { echo(input: { name: "nobody" }) { name } }')).rejects.toThrow(
      'Invalid input for "echo": input: nobody is reserved',
    );
  });

  it("hands the handler the parsed input, defaults applied", async () => {
    expect(await asAna('mutation { echo(input: { name: "abc" }) { name n } }')).toEqual({
      data: { echo: { name: "abc", n: 7 } },
    });
  });
});

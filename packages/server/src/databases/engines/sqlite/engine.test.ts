import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Provider } from "../../../ai/adapter";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * The whole path, from a GraphQL document to rows in a SQLite file, through the
 * same boot the server runs. It needs no database server, which is what lets it
 * live in the unit suite.
 */

const FIXTURE = `
  CREATE TABLE organizations (
    id          INTEGER PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    name_length INTEGER GENERATED ALWAYS AS (length(name)) VIRTUAL
  );
  CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations,
    manager_id      INTEGER REFERENCES users (id),
    display_name    VARCHAR(200) NOT NULL,
    is_active       BOOLEAN,
    avatar          BLOB,
    score           DECIMAL(6, 2),
    created_at      TIMESTAMP NOT NULL
  );
  INSERT INTO organizations VALUES (1, 'Acme'), (2, 'Umbrella');
  INSERT INTO users VALUES
    (1, 1, NULL, 'Ana Costa', TRUE,  x'0102', 4.5,  '2026-01-02 09:00:00'),
    (2, 1, 1,    'Brian',     FALSE, NULL,    NULL, '2026-01-03 09:00:00'),
    (3, 1, 1,    'Cleo 100%', NULL,  NULL,    1.25, '2026-01-04 09:00:00'),
    (4, 2, NULL, 'Dan',       TRUE,  NULL,    8,    '2026-01-05 09:00:00');
  CREATE TABLE catalog."order" (id INTEGER PRIMARY KEY, "user" TEXT NOT NULL);
  INSERT INTO catalog."order" VALUES (1, 'ana');
`;

type Engine = Awaited<ReturnType<typeof import("../../../index").createGraphQLEngine>>;

let dir: string;
let engine: Engine;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-sqlite-engine-"));
  const filename = join(dir, "app.db");
  const catalog = join(dir, "catalog.db");

  const seed = new SQLiteDatabase(filename, { create: true });
  seed.query("ATTACH DATABASE $file AS catalog").run({ $file: catalog });
  seed.run(FIXTURE);
  seed.close();

  const { createGraphQLEngine } = await import("../../../index");
  const { env } = await import("../../../singletons/env");

  engine = await createGraphQLEngine({
    dbConnectRetryMs: 0,
    ai: { ...env.ai, enabled: undefined, graphqlEnabled: true, timeoutMs: 60_000 },
    configuration: {
      name: "sqlite-engine-test",
      version: "1.0.0",
      ai: { enabled: true },
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename, attach: { catalog } },
        },
      ],
    } as never,
  });
});

afterAll(async () => {
  await engine?.close();
  // The boot set the process-wide timeout to QUERY_TIMEOUT_MS's default; a later
  // file's query generator would otherwise emit a timeout hint it does not expect.
  const { setQueryTimeoutMs } = await import("../../../singletons/queryTimeout");
  setQueryTimeoutMs(0);
  // It set up the agent too; a later file starts without one.
  const { resetAI } = await import("../../../singletons/ai");
  resetAI();
  await rm(dir, { recursive: true, force: true });
});

const run = async <T>(query: string, variables?: Record<string, unknown>) => {
  const result = (await engine.execute(query, variables)) as { data?: T; errors?: unknown[] };
  expect(result.errors ?? []).toEqual([]);
  return result.data as T;
};

const ids = (rows: { id: number }[] | undefined) =>
  (rows ?? []).map((row) => row.id).sort((a, b) => a - b);

describe("sqlite engine, end to end", () => {
  it("serves rows and both directions of a foreign key, including one naming only its parent", async () => {
    const data = await run<{
      main_users: { id: number; main_organizations: { name: string } }[];
      main_organizations: { name: string; main_users: { id: number }[] }[];
    }>(`{
      main_users(orderBy: [{ id: ASC }]) { id main_organizations { name } }
      main_organizations(orderBy: [{ id: ASC }]) {
        name
        main_users(orderBy: [{ id: DESC }], limit: 2) { id }
      }
    }`);

    expect(data.main_users.map((u) => u.main_organizations.name)).toEqual([
      "Acme",
      "Acme",
      "Acme",
      "Umbrella",
    ]);
    expect(data.main_organizations).toEqual([
      { name: "Acme", main_users: [{ id: 3 }, { id: 2 }] },
      { name: "Umbrella", main_users: [{ id: 4 }] },
    ]);
  });

  it("serves a generated column", async () => {
    const data = await run<{ main_organizations: { name: string; name_length: number }[] }>(
      `{ main_organizations(orderBy: [{ id: ASC }]) { name name_length } }`,
    );

    expect(data.main_organizations).toEqual([
      { name: "Acme", name_length: 4 },
      { name: "Umbrella", name_length: 8 },
    ]);
  });

  it("resolves the self-referential key both ways, and null for a missing row", async () => {
    const data = await run<{
      ana: { main_users_ref: unknown; main_users_list: { id: number }[] };
      nobody: unknown;
    }>(`{
      ana: main_users_single(where: { id: { eq: 1 } }) {
        main_users_ref { id }
        main_users_list(orderBy: [{ id: ASC }]) { id }
      }
      nobody: main_users_single(where: { id: { eq: 99 } }) { id }
    }`);

    expect(data.ana.main_users_ref).toBeNull();
    expect(data.ana.main_users_list).toEqual([{ id: 2 }, { id: 3 }]);
    expect(data.nobody).toBeNull();
  });

  it("reads booleans as booleans and a BLOB as hex, and the schema says so", async () => {
    const data = await run<{ main_users: { id: number; is_active: unknown; avatar: unknown }[] }>(
      `{ main_users(orderBy: [{ id: ASC }]) { id is_active avatar } }`,
    );

    expect(data.main_users).toEqual([
      { id: 1, is_active: true, avatar: "0102" },
      { id: 2, is_active: false, avatar: null },
      { id: 3, is_active: null, avatar: null },
      { id: 4, is_active: true, avatar: null },
    ]);

    const introspection = await run<{
      __schema: {
        types: {
          name: string;
          fields?: {
            name: string;
            type: { name: string | null; ofType: { name: string } | null };
          }[];
        }[];
      };
    }>(`query { __schema { queryType { name } } }`);
    const fieldType = (fieldName: string) => {
      const field = introspection.__schema.types
        .find((t) => t.name === "main_users")
        ?.fields?.find((f) => f.name === fieldName);
      return field?.type.name ?? field?.type.ofType?.name;
    };

    expect(fieldType("is_active")).toBe("Boolean");
    expect(fieldType("avatar")).toBe("String");
    expect(fieldType("score")).toBe("Float");
  });

  it("filters with in, an escaped like, is_null and a relationship", async () => {
    const data = await run<Record<string, { id: number }[]>>(
      `query Q($p: String) {
        inList:    main_users(where: { id: { in: [2, 4] } }) { id }
        like:      main_users(where: { display_name: { like: $p } }) { id }
        noManager: main_users(where: { manager_id: { is_null: true } }) { id }
        acme:      main_users(where: { main_organizations: { name: { eq: "Acme" } } }) { id }
      }`,
      { p: "%100\\%" },
    );

    expect(ids(data.inList)).toEqual([2, 4]);
    expect(ids(data.like)).toEqual([3]);
    expect(ids(data.noManager)).toEqual([1, 4]);
    expect(ids(data.acme)).toEqual([1, 2, 3]);
  });

  it("orders NULLS FIRST / LAST and paginates", async () => {
    const data = await run<Record<string, { id: number }[]>>(`{
      last:  main_users(orderBy: [{ score: ASC_NULLS_LAST }]) { id }
      first: main_users(orderBy: [{ score: DESC_NULLS_FIRST }]) { id }
      page:  main_users(limit: 2, offset: 1, orderBy: [{ id: ASC }]) { id }
    }`);

    expect(data.last!.map((r) => r.id)).toEqual([3, 1, 4, 2]);
    expect(data.first!.map((r) => r.id)).toEqual([2, 4, 1, 3]);
    expect(data.page!.map((r) => r.id)).toEqual([2, 3]);
  });

  it("groups, with a boolean key and with the grouped rows", async () => {
    const data = await run<{
      byActive: { key: { is_active: boolean | null }; count: number }[];
      byOrg: { key: { organization_id: number }; count: number; items: { id: number }[] }[];
    }>(`{
      byActive: main_users_aggregate(groupBy: [is_active]) { key { is_active } count }
      byOrg:    main_users_aggregate(groupBy: [organization_id]) {
        key { organization_id } count items { id }
      }
    }`);

    expect(
      Object.fromEntries(data.byActive.map((g) => [String(g.key.is_active), g.count])),
    ).toEqual({ true: 2, false: 1, null: 1 });
    expect(
      Object.fromEntries(data.byOrg.map((g) => [g.key.organization_id, ids(g.items)])),
    ).toEqual({ 1: [1, 2, 3], 2: [4] });
  });

  it("applies SQLite's forms of the directives", async () => {
    const data = await run<{ main_users_single: Record<string, string> }>(`{
      main_users_single(where: { id: { eq: 1 } }) {
        truncated: display_name @truncate(length: 3)
        padded:    display_name @pad(length: 12, char: "*", side: "left")
        rpadded:   display_name @pad(length: 12, char: "*", side: "right")
        cut:       display_name @pad(length: 3, char: "*", side: "left")
        pairs:     display_name @pad(length: 12, char: "ab", side: "left")
        sliced:    display_name @substring(start: 5, length: 5)
        formatted: created_at @dateFormat(format: "%Y-%m-%d")
        suffixed:  display_name @concat(with: "-X")
      }
    }`);

    expect(data.main_users_single).toEqual({
      truncated: "Ana",
      padded: "***Ana Costa",
      rpadded: "Ana Costa***",
      cut: "Ana",
      pairs: "abaAna Costa",
      sliced: "Costa",
      formatted: "2026-01-02",
      suffixed: "Ana Costa-X",
    });
  });

  it("applies the numeric directives", async () => {
    const data = await run<{ main_users_single: Record<string, number> }>(`{
      main_users_single(where: { id: { eq: 1 } }) {
        ceiled:  score @ceil
        floored: score @floor
        rounded: score @round
      }
    }`);

    expect(data.main_users_single).toEqual({ ceiled: 5, floored: 4, rounded: 5 });
  });

  it("serves an attached file as a schema, reserved words included", async () => {
    const data = await run<{ catalog_order: { id: number; user: string }[] }>(
      `{ catalog_order { id user } }`,
    );

    expect(data.catalog_order).toEqual([{ id: 1, user: "ana" }]);
  });
});

describe("sqlite engine, the agent", () => {
  // Reads through the tool the way a model would, then answers with what it read.
  // Without a signal, AI_TIMEOUT_MS never reached the agent through the boot.
  const readingOrganizations: Provider = {
    chat: async (messages, _tools, signal) => {
      if (!signal) throw new Error("no timeout reached the provider");
      const last = messages.at(-1)!;
      if (last.role === "tool") return { content: last.content, toolCalls: [] };
      return {
        content: "",
        toolCalls: [
          {
            id: "1",
            function: {
              name: "graphql_execute",
              arguments: { query: "{ main_organizations(orderBy: [{ id: ASC }]) { name } }" },
            },
          },
        ],
      };
    },
  };

  it("answers ask through the agent, whose tools read this engine's database", async () => {
    const { setProvider } = await import("../../../ai/agent/providers");
    setProvider(readingOrganizations);
    try {
      const data = await run<{ ask: string }>(`{ ask(prompt: "which organizations?") }`);

      expect(JSON.parse(data.ask)).toEqual({
        data: { main_organizations: [{ name: "Acme" }, { name: "Umbrella" }] },
      });
    } finally {
      setProvider(null);
    }
  });
});

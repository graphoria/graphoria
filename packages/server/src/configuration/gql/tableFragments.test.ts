import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * Fragments on table fields, through the boot the server runs and real SQL.
 * `ana` owns tasks 1 and 3; `bo` owns task 2.
 */

const BY_ID = "orderBy: [{ id: ASC }]";

let dir: string;
let engine: Awaited<ReturnType<typeof import("../../index").createGraphQLEngine>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-table-fragments-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run(
    "CREATE TABLE owners (id INTEGER PRIMARY KEY, email TEXT NOT NULL);" +
      "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL," +
      " owner_id INTEGER NOT NULL REFERENCES owners (id));" +
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);" +
      "INSERT INTO notes VALUES (1, 'note');" +
      "INSERT INTO owners VALUES (1, 'ana'), (2, 'bo');" +
      "INSERT INTO tasks VALUES (1, 'alpha', 'ana', 1), (2, 'beta', 'bo', 2), (3, 'gamma', 'ana', 1);",
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
    configuration: {
      name: "table-fragments-test",
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
        permissions: {
          member: {
            tables: {
              main_tasks: { columns: "ALL", filter: { owner: { eq: "$session.sub" } } },
              main_owners: { columns: "ALL", filter: { email: { eq: "$session.sub" } } },
            },
          },
          // `title` is withheld on tasks and readable on notes.
          reader: { tables: { main_tasks: { columns: ["id"] }, main_notes: { columns: "ALL" } } },
        },
      },
    } as never,
  });
});

afterAll(async () => {
  await engine?.close();
  await rm(dir, { recursive: true, force: true });
});

const asAna = (query: string, variables: Record<string, unknown> = {}) =>
  engine.execute(query, variables, { role: "member", session: { sub: "ana", role: "member" } });

describe("columns", () => {
  it("are selected by a named fragment", async () => {
    expect(
      await engine.execute(
        `{ main_tasks(${BY_ID}, limit: 2) { ...T } } fragment T on main_tasks { id title }`,
      ),
    ).toEqual({
      data: {
        main_tasks: [
          { id: 1, title: "alpha" },
          { id: 2, title: "beta" },
        ],
      },
    });
  });

  it.each([
    ["with a type condition", "... on main_tasks"],
    ["without one", "..."],
  ])("are selected by an inline fragment %s", async (_case, fragment) => {
    expect(
      await engine.execute(`{ main_tasks(${BY_ID}, limit: 1) { ${fragment} { id } } }`),
    ).toEqual({ data: { main_tasks: [{ id: 1 }] } });
  });

  it("are selected once when a fragment repeats them", async () => {
    expect(
      await engine.execute(
        `{ main_tasks(${BY_ID}, limit: 1) { id ...T } } fragment T on main_tasks { id title }`,
      ),
    ).toEqual({ data: { main_tasks: [{ id: 1, title: "alpha" }] } });
  });

  it.each([
    [true, { title: "alpha" }],
    [false, { id: 1, title: "alpha" }],
  ])("follow $s = %p inside a fragment, per request", async (s, row) => {
    const query = `query Q($s: Boolean!) { main_tasks(${BY_ID}, limit: 1) { ...T } } fragment T on main_tasks { id @skip(if: $s) title }`;

    expect(await engine.execute(query, { s })).toEqual({ data: { main_tasks: [row] } });
    expect(await engine.execute(query, { s: !s })).not.toEqual({ data: { main_tasks: [row] } });
    expect(await engine.execute(query, { s })).toEqual({ data: { main_tasks: [row] } });
  });

  it("carry a transform directive and its parameter from a fragment", async () => {
    expect(
      await engine.execute(
        `{ main_tasks(${BY_ID}, limit: 1) { ...T } } fragment T on main_tasks { short: title @truncate(length: 2) }`,
      ),
    ).toEqual({ data: { main_tasks: [{ short: "al" }] } });
  });
});

describe("relationships", () => {
  it("are followed through fragments, each with its own", async () => {
    expect(
      await engine.execute(
        `{ main_tasks(${BY_ID}, limit: 1) { ...T } }
         fragment T on main_tasks { main_owners { ...O } }
         fragment O on main_owners { email }`,
      ),
    ).toEqual({ data: { main_tasks: [{ main_owners: { email: "ana" } }] } });
  });

  it("merge the selections made in and out of a fragment", async () => {
    expect(
      await engine.execute(
        `{ main_tasks(${BY_ID}, limit: 1) { main_owners { id } ...T } }
         fragment T on main_tasks { main_owners { email } }`,
      ),
    ).toEqual({ data: { main_tasks: [{ main_owners: { id: 1, email: "ana" } }] } });
  });

  it("expand one fragment under every field that spreads it", async () => {
    expect(
      await engine.execute(
        `{ main_tasks(${BY_ID}, limit: 1) { a: main_owners { ...O } b: main_owners { ...O } } }
         fragment O on main_owners { id }`,
      ),
    ).toEqual({ data: { main_tasks: [{ a: { id: 1 }, b: { id: 1 } }] } });
  });
});

describe("root fragments", () => {
  it("carry the literals of a field, defined after the operation", async () => {
    expect(
      await engine.execute(
        `{ ...R } fragment R on Query { main_tasks(${BY_ID}, limit: 2) { id } }`,
      ),
    ).toEqual({ data: { main_tasks: [{ id: 1 }, { id: 2 }] } });
  });

  it("carry a where literal, defined before the operation", async () => {
    expect(
      await engine.execute(
        `fragment R on Query { main_tasks(where: { title: { eq: "beta" } }) { id } } { ...R }`,
      ),
    ).toEqual({ data: { main_tasks: [{ id: 2 }] } });
  });

  it("read the operation's variables", async () => {
    expect(
      await engine.execute(
        `query Q($t: String!) { ...R } fragment R on Query { main_tasks(where: { title: { eq: $t } }) { id } }`,
        { t: "gamma" },
      ),
    ).toEqual({ data: { main_tasks: [{ id: 3 }] } });
  });
});

describe("aggregates", () => {
  it("are selected through fragments", async () => {
    expect(
      await engine.execute(
        `{ main_tasks_aggregate(groupBy: [owner_id], orderBy: [{ owner_id: ASC }]) { ...G } }
         fragment G on main_tasksGroupBy { key { ... { owner_id } } count }`,
      ),
    ).toEqual({
      data: {
        main_tasks_aggregate: [
          { key: { owner_id: 1 }, count: 2 },
          { key: { owner_id: 2 }, count: 1 },
        ],
      },
    });
  });
});

describe("a role's filter", () => {
  it("binds its session claim for a field in a root fragment", async () => {
    expect(await asAna(`{ ...R } fragment R on Query { main_tasks(${BY_ID}) { id } }`)).toEqual({
      data: { main_tasks: [{ id: 1 }, { id: 3 }] },
    });
  });

  it("applies to a relationship reached through fragments", async () => {
    expect(
      await asAna(
        `{ main_owners { ...O } } fragment O on main_owners { email main_tasks(${BY_ID}) { ...T } }
         fragment T on main_tasks { id }`,
      ),
    ).toEqual({
      data: { main_owners: [{ email: "ana", main_tasks: [{ id: 1 }, { id: 3 }] }] },
    });
  });

  it("replaces a where in a fragment naming another owner", async () => {
    expect(
      await asAna(
        `{ ...R } fragment R on Query { main_tasks(${BY_ID}, where: { owner: { eq: "bo" } }) { id } }`,
      ),
    ).toEqual({ data: { main_tasks: [{ id: 1 }, { id: 3 }] } });
  });

  it("holds on every occurrence a fragment merges", async () => {
    expect(
      await asAna(
        `{ main_tasks(${BY_ID}) { id } ...R } fragment R on Query { main_tasks(where: { id: { eq: 2 } }) { title } }`,
      ),
    ).toEqual({ data: { main_tasks: [] } });
  });
});

describe("a response key selected by more than one field", () => {
  const asReader = (query: string) =>
    engine.execute(query, {}, { role: "reader", session: { sub: "r", role: "reader" } });

  it("withholds the column the control query is denied", async () => {
    expect(await asReader(`{ main_tasks { title } }`)).toHaveProperty("errors");
  });

  it.each([
    [
      "a directive",
      `{ x: main_notes { title } x: main_tasks(${BY_ID}, limit: 1) @include(if: true) { id } }`,
    ],
    [
      "a root-level fragment",
      `{ ...R } fragment R on Query { x: main_notes { title } x: main_tasks(${BY_ID}, limit: 1) { id } }`,
    ],
  ])("does not read one field's selection from another, through %s", async (_case, query) => {
    expect(await asReader(query)).toEqual({ data: { x: [{ id: 1 }] } });
  });

  it("answers the last occurrence alone when the arguments differ", async () => {
    expect(
      await asAna(
        `{ x: main_owners(limit: 1) { main_tasks { id } } x: main_owners(limit: 2) @include(if: true) { email } }`,
      ),
    ).toEqual({ data: { x: [{ email: "ana" }] } });
  });

  it("merges occurrences with equal literals", async () => {
    expect(
      await asAna(
        `{ main_owners(limit: 1) { id } ...R } fragment R on Query { main_owners(limit: 1) { email } }`,
      ),
    ).toEqual({ data: { main_owners: [{ id: 1, email: "ana" }] } });
  });
});

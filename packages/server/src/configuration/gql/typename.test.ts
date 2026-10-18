import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * `__typename` below the root, through the boot the server runs: each object a
 * response carries answers the name of its GraphQL type.
 */

let dir: string;
let engine: Awaited<ReturnType<typeof import("../../index").createGraphQLEngine>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-typename-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run(
    "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);" +
      "CREATE TABLE books (id INTEGER PRIMARY KEY, pages INTEGER NOT NULL," +
      " author_id INTEGER NOT NULL REFERENCES authors (id));" +
      "INSERT INTO authors VALUES (1, 'Ann'), (2, 'Bo');" +
      "INSERT INTO books VALUES (1, 100, 1), (2, 200, 1), (3, 300, 2);",
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
      name: "typename-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename: join(dir, "app.db") },
        },
      ],
    } as never,
  });
});

afterAll(async () => {
  await engine?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("objects SQL builds", () => {
  it("name their type, under an alias too", async () => {
    expect(
      await engine.execute(
        "{ main_books(orderBy: [{ id: ASC }], limit: 2) { __typename kind: __typename id } }",
      ),
    ).toEqual({
      data: {
        main_books: [
          { __typename: "main_books", kind: "main_books", id: 1 },
          { __typename: "main_books", kind: "main_books", id: 2 },
        ],
      },
    });
  });

  it("name their type across relationships and on a single row", async () => {
    expect(
      await engine.execute(`{
        main_books_single(where: { id: { eq: 3 } }) {
          __typename
          main_authors { __typename name }
        }
        main_authors(orderBy: [{ id: ASC }]) {
          id
          main_books(orderBy: [{ id: ASC }]) { __typename id }
        }
      }`),
    ).toEqual({
      data: {
        main_books_single: {
          __typename: "main_books",
          main_authors: { __typename: "main_authors", name: "Bo" },
        },
        main_authors: [
          {
            id: 1,
            main_books: [
              { __typename: "main_books", id: 1 },
              { __typename: "main_books", id: 2 },
            ],
          },
          { id: 2, main_books: [{ __typename: "main_books", id: 3 }] },
        ],
      },
    });
  });

  it("name a group, its key, its aggregates and its rows", async () => {
    expect(
      await engine.execute(`{
        main_books_aggregate(groupBy: [author_id], orderBy: [{ author_id: ASC }]) {
          __typename
          key { __typename author_id }
          count
          sum { __typename pages }
          items { __typename }
        }
      }`),
    ).toEqual({
      data: {
        main_books_aggregate: [
          {
            __typename: "main_booksGroupBy",
            key: { __typename: "main_books", author_id: 1 },
            count: 2,
            sum: { __typename: "main_booksSum", pages: 300 },
            items: [{ __typename: "main_books" }, { __typename: "main_books" }],
          },
          {
            __typename: "main_booksGroupBy",
            key: { __typename: "main_books", author_id: 2 },
            count: 1,
            sum: { __typename: "main_booksSum", pages: 300 },
            items: [{ __typename: "main_books" }],
          },
        ],
      },
    });
  });

  it("answer a key that selects nothing but its type name", async () => {
    expect(
      await engine.execute("{ main_books_aggregate(groupBy: [author_id]) { key { __typename } } }"),
    ).toEqual({
      data: {
        main_books_aggregate: [
          { key: { __typename: "main_books" } },
          { key: { __typename: "main_books" } },
        ],
      },
    });
  });

  it("leave out a __typename a directive skips", async () => {
    expect(
      await engine.execute(
        "{ main_books(orderBy: [{ id: ASC }], limit: 1) { __typename @skip(if: true) id } }",
      ),
    ).toEqual({ data: { main_books: [{ id: 1 }] } });
  });
});

import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load; JWT_SECRET too, since the
// first file to load it fixes env.jwt for every later file.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

/**
 * Virtual columns through the boot the server runs, on SQLite: directives apply
 * as on a physical column, and a boolean or a blob answers as a physical one does.
 */

let dir: string;
let engine: Awaited<ReturnType<typeof import("../../index").createGraphQLEngine>>;

type People = { data: { main_people: Record<string, unknown>[] } };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-virtual-columns-"));
  const seed = new SQLiteDatabase(join(dir, "app.db"), { create: true });
  seed.run(
    "CREATE TABLE people (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, flag BOOLEAN, data BLOB);" +
      "INSERT INTO people VALUES (1, 'Ana', 'Costa', 0, x'00ff'), (2, 'Bo', 'Li', 1, x''), (3, 'Cy', 'Ng', 2, NULL)," +
      " (4, 'Di', 'Oz', 0.5, NULL), (5, 'Ed', 'Po', 'abc', NULL), (6, 'Fa', 'Qi', '1', NULL), (7, 'Gu', 'Ra', '0', NULL), (8, 'Ha', 'Su', NULL, NULL);",
  );
  seed.close();

  const { createGraphQLEngine } = await import("../../index");
  const { env } = await import("../../singletons/env");
  const { virtualColumnExpression } = await import("../../config/types/virtual-columns");

  engine = await createGraphQLEngine({
    dbConnectRetryMs: 0,
    // A boot sets the process-wide query timeout, so it gets 0, its value before any boot.
    queryTimeoutMs: 0,
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: {
      name: "virtual-columns-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename: join(dir, "app.db") },
          schema: {
            database: {
              main_people: {
                columns: [
                  virtualColumnExpression(
                    "v_name",
                    "text",
                    false,
                    "first_name || ' ' || last_name",
                  ),
                  virtualColumnExpression("v_len", "int", false, "length(first_name)"),
                  virtualColumnExpression("v_flag", "boolean", true, "flag"),
                  virtualColumnExpression("v_data", "blob", true, "data"),
                ],
              },
            },
          },
        },
      ],
    },
  });
});

afterAll(async () => {
  await engine?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("virtual columns on SQLite", () => {
  it("take the transform directives a physical column takes", async () => {
    const { data } = (await engine.execute(
      "{ main_people(orderBy: [{ id: ASC }], limit: 1) { first_name @uppercase v_name @uppercase v_len @multiply(by: 2) } }",
    )) as People;

    expect(data.main_people).toEqual([{ first_name: "ANA", v_name: "ANA COSTA", v_len: 6 }]);
  });

  it("answer a boolean and a blob as the physical encoding does", async () => {
    const { data } = (await engine.execute(
      "{ main_people(orderBy: [{ id: ASC }]) { flag v_flag data v_data } }",
    )) as People;

    expect(data.main_people.map((row) => row["v_flag"])).toEqual(
      data.main_people.map((row) => row["flag"]),
    );
    expect(data.main_people.map((row) => row["v_flag"])).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      false,
      null,
    ]);
    expect(data.main_people.map((row) => row["v_data"])).toEqual(
      data.main_people.map((row) => row["data"]),
    );
    expect(data.main_people.slice(0, 3).map((row) => row["v_data"])).toEqual(["00FF", "", null]);
  });
});

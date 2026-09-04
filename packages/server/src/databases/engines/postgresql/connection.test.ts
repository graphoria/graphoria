import { afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { Database } from "../../../types/configuration";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

let poolOptions: (
  db: Database,
  timeoutMs?: number,
) => ReturnType<typeof import("./connection").poolOptions>;

let callStoredProcedure: typeof import("./connection").callStoredProcedure;
let databasesConnections: typeof import("../../../singletons/databases").databasesConnections;

beforeAll(async () => {
  ({ poolOptions, callStoredProcedure } = await import("./connection"));
  ({ databasesConnections } = await import("../../../singletons/databases"));
});

const db = (connectionOptions?: unknown): Database =>
  ({
    name: "default",
    type: "pg",
    connection: {
      host: "localhost",
      port: 5432,
      user: "u",
      password: "p",
      database: "d",
    },
    connectionOptions,
  }) as unknown as Database;

describe("postgresql poolOptions", () => {
  it("applies the schema defaults when connectionOptions is omitted", () => {
    expect(poolOptions(db())).toMatchObject({
      max: 10,
      idleTimeout: 30,
      connectionTimeout: 30,
      maxLifetime: 3600,
    });
  });

  it("lets a database override any bound", () => {
    expect(poolOptions(db({ max: 3, connectionTimeout: 5 }))).toMatchObject({
      max: 3,
      connectionTimeout: 5,
      idleTimeout: 30,
    });
  });
});

describe("postgresql poolOptions statement_timeout", () => {
  // Applied once per pooled connection rather than per query, so it bounds
  // everything that runs on the connection — auth and introspection included —
  // at no per-query cost.
  it("bounds every connection in the pool", () => {
    expect(poolOptions(db(), 10_000).connection).toEqual({ statement_timeout: "10000" });
  });

  it("omits the option entirely when the timeout is disabled", () => {
    expect(poolOptions(db(), 0).connection).toBeUndefined();
  });
});

type RecordedQuery = { query: string; params: unknown[] };

const fakePool = (recorded: RecordedQuery[]) => ({
  unsafe: async (query: string, params: unknown[]) => {
    recorded.push({ query, params });
    return [];
  },
});

const procedure = () =>
  ({
    db: db(),
    dottedQuotedName: '"public"."create_order"',
    parameters: [
      { name: "customer", dataType: "text", maxLength: 0, precision: 0, scale: 0 },
      { name: "total", dataType: "numeric", maxLength: 0, precision: 0, scale: 0 },
    ],
  }) as unknown as Parameters<typeof callStoredProcedure>[0];

describe("postgresql callStoredProcedure", () => {
  afterEach(() => {
    delete databasesConnections.default;
  });

  // The placeholders are positional, so the list that numbers them has to be
  // the list that orders the values. The operation's variable definitions are
  // neither: they describe the GraphQL query's `$vars`, not the procedure's
  // arguments.
  it("binds arguments in procedure signature order, whatever order they were supplied in", async () => {
    const recorded: RecordedQuery[] = [];
    databasesConnections.default = fakePool(
      recorded,
    ) as unknown as (typeof databasesConnections)[string];

    await callStoredProcedure(procedure(), [{ name: "limit", type: "Int", required: false }], {
      total: 42,
      customer: "acme",
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.query).toBe('SELECT * FROM "public"."create_order"($1, $2);');
    expect(recorded[0]!.params).toEqual(["acme", 42]);
  });
});

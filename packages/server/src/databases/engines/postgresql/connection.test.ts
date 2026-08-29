import { beforeAll, describe, expect, it } from "bun:test";

import type { Database } from "../../../types/configuration";

// `singletons/env` parses process.env at module load. Ensure required vars exist
// before any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

let poolOptions: (
  db: Database,
  timeoutMs?: number,
) => ReturnType<typeof import("./connection").poolOptions>;

beforeAll(async () => {
  ({ poolOptions } = await import("./connection"));
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

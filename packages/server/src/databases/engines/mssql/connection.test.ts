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
    type: "mssql",
    connection: {
      host: "localhost",
      port: 1433,
      user: "u",
      password: "p",
      database: "d",
    },
    connectionOptions,
  }) as unknown as Database;

describe("mssql poolOptions", () => {
  it("applies the schema defaults when connectionOptions is omitted", () => {
    expect(poolOptions(db(), 10_000)).toMatchObject({
      connectionTimeout: 30_000,
      requestTimeout: 10_000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30_000,
        acquireTimeoutMillis: 30_000,
      },
    });
  });

  it("bounds the wait for a free connection so a saturated pool fails rather than queues", () => {
    expect(poolOptions(db({ pool: { acquireTimeout: 5 } })).pool).toMatchObject({
      acquireTimeoutMillis: 5_000,
      max: 10,
    });
  });

  // These three keep their code fallbacks rather than the schema's, so pool
  // sizing does not quietly change how a connection is secured.
  it("leaves the transport flags on their established defaults", () => {
    expect(poolOptions(db()).options).toEqual({
      encrypt: false,
      trustServerCertificate: true,
      trustedConnection: true,
    });
  });

  // `connectionOptions` is an undiscriminated union of the two engine shapes,
  // so an object carrying nothing MSSQL-specific validates against the Bun SQL
  // one even on an MSSQL database. Re-parsing that strictly would reject its
  // keys and take the server down at boot.
  it("survives options that were validated against the Bun SQL shape", () => {
    const bunShaped = {
      max: 10,
      idleTimeout: 30,
      connectionTimeout: 45,
      maxLifetime: 3600,
      tls: false,
      prepare: true,
      bigint: false,
    };

    expect(poolOptions(db(bunShaped))).toMatchObject({
      connectionTimeout: 45_000,
      pool: { max: 10, min: 0, acquireTimeoutMillis: 30_000 },
    });
  });
});

describe("mssql poolOptions requestTimeout", () => {
  // tedious sends an attention packet on timeout and the server aborts the
  // request, so this is a real server-side bound, not a client-side give-up.
  it("takes the resolved timeout when connectionOptions omits requestTimeout", () => {
    expect(poolOptions(db(), 2_500).requestTimeout).toBe(2_500);
  });

  // Only an omitted key falls through to the env default. Anyone who
  // deliberately raised requestTimeout for a slow report keeps that value.
  it("lets an explicit requestTimeout win over the resolved timeout", () => {
    expect(poolOptions(db({ requestTimeout: 120 }), 10_000).requestTimeout).toBe(120_000);
  });

  it("passes 0 through, which tedious reads as no timeout", () => {
    expect(poolOptions(db(), 0).requestTimeout).toBe(0);
  });
});

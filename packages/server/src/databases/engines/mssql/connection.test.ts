import { describe, expect, it } from "bun:test";

import type { Database } from "../../../types/configuration";

import { poolOptions } from "./connection";

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
    expect(poolOptions(db())).toMatchObject({
      connectionTimeout: 30_000,
      requestTimeout: 30_000,
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
});

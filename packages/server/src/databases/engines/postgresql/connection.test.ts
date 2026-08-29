import { describe, expect, it } from "bun:test";

import type { Database } from "../../../types/configuration";

import { poolOptions } from "./connection";

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

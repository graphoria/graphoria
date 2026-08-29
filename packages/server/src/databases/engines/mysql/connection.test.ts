import { describe, expect, it } from "bun:test";

import type { Database } from "../../../types/configuration";

import { poolOptions } from "./connection";

const db = (connectionOptions?: unknown): Database =>
  ({
    name: "default",
    type: "mysql",
    connection: {
      host: "localhost",
      port: 3306,
      user: "u",
      password: "p",
      database: "d",
    },
    connectionOptions,
  }) as unknown as Database;

describe("mysql poolOptions", () => {
  it("applies the schema defaults when connectionOptions is omitted", () => {
    expect(poolOptions(db())).toMatchObject({
      max: 10,
      idleTimeout: 30,
      connectionTimeout: 30,
      maxLifetime: 3600,
    });
  });

  it("lets a database override any bound", () => {
    expect(poolOptions(db({ max: 25, idleTimeout: 5 }))).toMatchObject({
      max: 25,
      idleTimeout: 5,
      connectionTimeout: 30,
    });
  });
});

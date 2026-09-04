import { afterEach, describe, expect, it } from "bun:test";

import type { Database } from "../../../types/configuration";

import { databasesConnections } from "../../../singletons/databases";
import { callStoredProcedure, poolOptions } from "./connection";

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
    dottedQuotedName: "`d`.`create_order`",
    parameters: [
      { name: "customer", dataType: "varchar", maxLength: 50, precision: 0, scale: 0 },
      { name: "total", dataType: "decimal", maxLength: 0, precision: 10, scale: 2 },
    ],
  }) as unknown as Parameters<typeof callStoredProcedure>[0];

describe("mysql callStoredProcedure", () => {
  afterEach(() => {
    delete databasesConnections.default;
  });

  // The placeholders are positional, so the list that numbers them has to be
  // the list that orders the values. The caller's argument object is neither:
  // its key order follows the GraphQL query text.
  it("binds arguments in procedure signature order, whatever order they were supplied in", async () => {
    const recorded: RecordedQuery[] = [];
    databasesConnections.default = fakePool(
      recorded,
    ) as unknown as (typeof databasesConnections)[string];

    await callStoredProcedure(procedure(), { total: 42, customer: "acme" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.query).toBe("CALL `d`.`create_order`(?, ?);");
    expect(recorded[0]!.params).toEqual(["acme", 42]);
  });
});

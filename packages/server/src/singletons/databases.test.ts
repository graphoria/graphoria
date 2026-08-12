import { describe, expect, it, mock } from "bun:test";

const fakeConnection = { tag: "fake-sql" } as unknown as import("bun").SQL;

mock.module("../databases/engines/postgresql/connection.ts", () => ({
  getPool: async () => fakeConnection,
}));

const { instantiateDatabasesConnections, databasesConnections } = await import("./databases");

const baseDb = {
  name: "onconnect_test",
  enabled: true,
  type: "pg" as const,
  connection: { host: "localhost", port: 5432, user: "u", password: "p", database: "db" },
};

describe("instantiateDatabasesConnections onConnect", () => {
  it("calls onConnect with the connection and db config", async () => {
    let receivedConnection: unknown;
    let receivedDb: unknown;

    const db = {
      ...baseDb,
      onConnect: (connection: unknown, passedDb: unknown) => {
        receivedConnection = connection;
        receivedDb = passedDb;
      },
    } as never;

    await instantiateDatabasesConnections([db]);

    expect(receivedConnection).toBe(fakeConnection);
    expect(receivedDb).toBe(db);
    delete databasesConnections[baseDb.name];
  });

  it("aborts boot when onConnect throws", async () => {
    const db = {
      ...baseDb,
      name: "onconnect_throw",
      onConnect: () => {
        throw new Error("startup sql failed");
      },
    } as never;

    await expect(instantiateDatabasesConnections([db])).rejects.toThrow("startup sql failed");
    delete databasesConnections["onconnect_throw"];
  });
});

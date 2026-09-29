import { Database as SQLiteDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import type { Auth, Database } from "../../../types/configuration";

import {
  checkUserCredentials,
  createAuthTables,
  insertAuthUser,
  verifyAuthTablesExist,
} from "./auth";

const sqliteDb = (attach?: Record<string, string>) =>
  ({
    name: "default",
    enabled: true,
    type: "sqlite",
    connection: { filename: ":memory:", ...(attach ? { attach } : {}) },
    fieldNaming: "{schema}_{name}",
  }) as Database;

const db = sqliteDb({ auth: ":memory:" });
const auth = { schema: "auth", databaseEntity: db } as unknown as Auth;

let connection: SQLiteDatabase;

beforeEach(() => {
  connection = new SQLiteDatabase(":memory:");
  connection.run("ATTACH DATABASE ':memory:' AS auth");
});

describe("sqlite createAuthTables", () => {
  it("creates the user table in the attached schema, and again without error", async () => {
    await createAuthTables(auth, connection);
    await createAuthTables(auth, connection);

    const columns = connection
      .query(`SELECT name FROM pragma_table_info('user', 'auth')`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(columns).toEqual(["username", "password", "role", "is_active", "claims"]);
  });

  it("names the fix when the auth schema is not attached", async () => {
    const unattached = { schema: "auth", databaseEntity: sqliteDb() } as unknown as Auth;

    await expect(createAuthTables(unattached, connection)).rejects.toThrow(
      'add it under connection.attach, or set auth.schema to "main"',
    );
  });

  it("finds the attached schema whatever the case of its name, as SQLite does", async () => {
    const upperCase = { schema: "Auth", databaseEntity: db } as unknown as Auth;

    await createAuthTables(upperCase, connection);

    expect(
      connection.query(`SELECT name FROM pragma_table_list WHERE schema = 'auth'`).all(),
    ).toContainEqual({ name: "user" });
  });
});

describe("sqlite verifyAuthTablesExist", () => {
  it("fails before the table exists and passes after", async () => {
    await expect(verifyAuthTablesExist(auth, connection)).rejects.toThrow();
    await createAuthTables(auth, connection);
    await expect(verifyAuthTablesExist(auth, connection)).resolves.toBeUndefined();
  });

  it("names the fix when the auth schema is not attached", async () => {
    const unattached = { schema: "auth", databaseEntity: sqliteDb() } as unknown as Auth;

    await expect(verifyAuthTablesExist(unattached, connection)).rejects.toThrow(
      'add it under connection.attach, or set auth.schema to "main"',
    );
  });
});

describe("sqlite login", () => {
  beforeEach(async () => {
    await createAuthTables(auth, connection);
    await insertAuthUser(
      auth,
      { username: "alice", password: "plain", role: "admin", claims: { tenant: "acme" } },
      connection,
    );
  });

  it("stores an argon2id hash, not the password", () => {
    const row = connection.query(`SELECT password FROM auth."user"`).get() as { password: string };

    expect(row.password.startsWith("$argon2id$")).toBe(true);
  });

  it("accepts the right password and returns role and claims", async () => {
    expect(await checkUserCredentials(db, auth, "alice", "plain", connection)).toEqual({
      valid: true,
      role: "admin",
      claims: { tenant: "acme" },
    });
  });

  it.each([
    ["a wrong password", "", "wrong"],
    ["an inactive user", `UPDATE auth."user" SET is_active = FALSE`, "plain"],
    ["malformed claims", `UPDATE auth."user" SET claims = 'not json'`, "plain"],
  ])("rejects %s", async (_what, update, password) => {
    if (update) connection.run(update);

    expect(await checkUserCredentials(db, auth, "alice", password, connection)).toEqual({
      valid: false,
      role: null,
      claims: null,
    });
  });
});

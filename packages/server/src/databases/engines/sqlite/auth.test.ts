import { Database as SQLiteDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import type { Auth, Database } from "../../../types/configuration";

import {
  checkUserCredentials,
  createAuthTables,
  deleteAuthUser,
  getAuthUser,
  insertAuthUser,
  listAuthUsers,
  resetAuthUserPassword,
  setAuthUserActive,
  updateAuthUser,
  verifyAuthTablesExist,
} from "./auth";
import { AuthUserExistsError } from "../../auth/users";

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

  it("names a taken username instead of the driver's constraint error", async () => {
    const insert = insertAuthUser(
      auth,
      { username: "alice", password: "other", role: "admin" },
      connection,
    );

    await expect(insert).rejects.toBeInstanceOf(AuthUserExistsError);
    await expect(insert).rejects.toThrow('User "alice" already exists');
  });
});

describe("sqlite insertAuthUser", () => {
  it("rethrows any other driver error untouched", async () => {
    // The top-level beforeEach attaches the schema but creates no table.
    await expect(
      insertAuthUser(auth, { username: "alice", password: "plain", role: "admin" }, connection),
    ).rejects.toThrow("no such table");
  });
});

describe("sqlite listAuthUsers", () => {
  const list = (search = "", role = "", offset = 0, limit = 10) =>
    listAuthUsers(auth, { search, role, offset, limit }, connection);
  const names = async (...args: Parameters<typeof list>) =>
    (await list(...args)).users.map((user) => user.username);

  beforeEach(async () => {
    await createAuthTables(auth, connection);
    connection.run(
      `INSERT INTO auth."user" (username, password, role, is_active) VALUES
         ('bob', 'x', 'reader', TRUE), ('Adam', 'x', 'editor', TRUE), ('ada', 'x', 'editor', FALSE),
         ('a_b', 'x', 'editor', TRUE), ('axb', 'x', 'editor', TRUE)`,
    );
  });

  it("lists users by username with whether each is active, and their total", async () => {
    expect(await list()).toEqual({
      users: [
        { username: "Adam", role: "editor", isActive: true },
        { username: "a_b", role: "editor", isActive: true },
        { username: "ada", role: "editor", isActive: false },
        { username: "axb", role: "editor", isActive: true },
        { username: "bob", role: "reader", isActive: true },
      ],
      total: 5,
    });
  });

  it("reads limit rows after offset, the total counting every row", async () => {
    const { users, total } = await list("", "", 1, 2);

    expect(users.map((user) => user.username)).toEqual(["a_b", "ada"]);
    expect(total).toBe(5);
  });

  it("keeps the usernames that contain the search, in any case, wildcards taken literally", async () => {
    expect(await names("AD")).toEqual(["Adam", "ada"]);
    expect(await names("a_b")).toEqual(["a_b"]);
    expect(await names("%")).toEqual([]);
  });

  it("keeps one role, with the search too, and counts only what matches", async () => {
    expect(await list("", "reader")).toEqual({
      users: [{ username: "bob", role: "reader", isActive: true }],
      total: 1,
    });
    expect((await list("a", "editor")).total).toBe(4);
  });
});

describe("sqlite user mutations", () => {
  const seed = async () =>
    insertAuthUser(
      auth,
      { username: "ada", password: "correct-horse", role: "editor", claims: { a: 1 } },
      connection,
    );

  beforeEach(async () => {
    await createAuthTables(auth, connection);
  });

  it("reads a user without its password", async () => {
    await seed();
    expect(await getAuthUser(auth, "ada", connection)).toEqual({
      username: "ada",
      role: "editor",
      isActive: true,
    });
    expect(await getAuthUser(auth, "nobody", connection)).toBeNull();
  });

  it("replaces role and claims, keeping the password", async () => {
    await seed();
    await updateAuthUser(auth, { username: "ada", role: "reader", claims: { b: 2 } }, connection);
    expect(await getAuthUser(auth, "ada", connection)).toEqual({
      username: "ada",
      role: "reader",
      isActive: true,
    });
    expect((await checkUserCredentials(db, auth, "ada", "correct-horse", connection)).valid).toBe(
      true,
    );
    expect(connection.query(`SELECT claims FROM "user" WHERE username = 'ada'`).get()).toEqual({
      claims: '{"b":2}',
    });
  });

  it("sets the active flag both ways", async () => {
    await seed();
    await setAuthUserActive(auth, { username: "ada", isActive: false }, connection);
    expect((await getAuthUser(auth, "ada", connection))!.isActive).toBe(false);
    await setAuthUserActive(auth, { username: "ada", isActive: true }, connection);
    expect((await getAuthUser(auth, "ada", connection))!.isActive).toBe(true);
  });

  it("deletes the user", async () => {
    await seed();
    await deleteAuthUser(auth, "ada", connection);
    expect(await getAuthUser(auth, "ada", connection)).toBeNull();
  });

  it("stores a new argon2id password the old one no longer opens", async () => {
    await seed();
    await resetAuthUserPassword(auth, { username: "ada", password: "another-horse" }, connection);
    expect((await checkUserCredentials(db, auth, "ada", "another-horse", connection)).valid).toBe(
      true,
    );
    expect((await checkUserCredentials(db, auth, "ada", "correct-horse", connection)).valid).toBe(
      false,
    );
  });
});

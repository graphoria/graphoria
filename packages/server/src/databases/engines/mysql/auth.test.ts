import { beforeAll, describe, expect, it } from "bun:test";

import type { SQL } from "bun";
import type { Auth, Database } from "../../../types/configuration";

import { dbMySQL } from "../../../__test/dbMocks";
import { hashPassword, verifyPassword } from "../../auth/password";
import { AuthUserExistsError } from "../../auth/users";
import {
  checkUserCredentials,
  deleteAuthUser,
  getAuthUser,
  insertAuthUser,
  listAuthUsers,
  resetAuthUserPassword,
  setAuthUserActive,
  updateAuthUser,
} from "./auth";

const recordingSQL = (): {
  sql: SQL;
  calls: { query: string; params: unknown[] }[];
} => {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql = {
    unsafe: async (query: string, params: unknown[] = []) => {
      calls.push({ query, params });
      return [] as unknown[];
    },
  };
  return { sql: sql as unknown as SQL, calls };
};

type UserRow = {
  username: string;
  password: string;
  role: string;
  is_active: boolean;
  claims: Record<string, unknown>;
};

const selectingSQL = (rows: UserRow[]): SQL => {
  const sql = {
    unsafe: async () => rows,
  };
  return sql as unknown as SQL;
};

const throwingSQL = (error: unknown): SQL =>
  ({
    unsafe: async () => {
      throw error;
    },
  }) as unknown as SQL;

const auth = {
  schema: "auth",
  databaseEntity: dbMySQL,
} as unknown as Auth;
const db = dbMySQL satisfies Database;

describe("mysql insertAuthUser", () => {
  it("inserts argon2id-hashed user with backtick-quoted identifiers", async () => {
    const { sql, calls } = recordingSQL();

    await insertAuthUser(
      auth,
      {
        username: "alice",
        password: "plain",
        role: "admin",
        claims: { tenant: "acme" },
      },
      sql,
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;

    expect(call.query).toContain("`auth`.`user`");
    // Bun's MySQL adapter binds `?` positionally; `$n` reaches the server as an
    // identifier and the statement fails with "Unknown column '$1'".
    expect(call.query).not.toContain("$1");
    expect(call.query.match(/\?/g)).toHaveLength(4);

    expect(call.params[0]).toBe("alice");
    expect(call.params[2]).toBe("admin");
    expect(call.params[3]).toBe('{"tenant":"acme"}');

    const hashed = call.params[1] as string;
    expect(hashed.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("plain", hashed)).toBe(true);
  });

  it("defaults claims to {} when omitted", async () => {
    const { sql, calls } = recordingSQL();

    await insertAuthUser(auth, { username: "bob", password: "p", role: "user" }, sql);

    expect(calls[0].params[3]).toBe("{}");
  });

  it("rejects unsafe schema identifier", async () => {
    const { sql } = recordingSQL();
    const evil = {
      schema: "auth`; DROP TABLE users--",
      databaseEntity: dbMySQL,
    } as unknown as Auth;

    await expect(
      insertAuthUser(evil, { username: "x", password: "p", role: "r" }, sql),
    ).rejects.toThrow();
  });

  it("names a taken username instead of the driver's duplicate entry", async () => {
    const duplicate = Object.assign(new Error("Duplicate entry 'alice' for key 'user.PRIMARY'"), {
      errno: 1062,
    });

    const insert = insertAuthUser(
      auth,
      { username: "alice", password: "plain", role: "admin" },
      throwingSQL(duplicate),
    );

    await expect(insert).rejects.toBeInstanceOf(AuthUserExistsError);
    await expect(insert).rejects.toThrow('User "alice" already exists');
  });

  it("rethrows any other driver error untouched", async () => {
    const lost = Object.assign(new Error("Lost connection to MySQL server"), { errno: 2013 });

    await expect(
      insertAuthUser(
        auth,
        { username: "alice", password: "plain", role: "admin" },
        throwingSQL(lost),
      ),
    ).rejects.toBe(lost);
  });
});

describe("mysql checkUserCredentials", () => {
  let validHash: string;

  beforeAll(async () => {
    validHash = await hashPassword("correct-horse");
  });

  it("returns valid + role + claims for a matching login", async () => {
    const sql = selectingSQL([
      {
        username: "alice",
        password: validHash,
        role: "admin",
        is_active: true,
        claims: { tenant: "acme" },
      },
    ]);

    const result = await checkUserCredentials(db, auth, "alice", "correct-horse", sql);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.role).toBe("admin");
    expect(result.claims).toEqual({ tenant: "acme" });
  });

  it("returns invalid when no rows match", async () => {
    const sql = selectingSQL([]);

    const result = await checkUserCredentials(db, auth, "ghost", "anything", sql);

    expect(result).toEqual({ valid: false, role: null, claims: null });
  });

  it("returns invalid when password does not verify", async () => {
    const sql = selectingSQL([
      {
        username: "alice",
        password: validHash,
        role: "admin",
        is_active: true,
        claims: {},
      },
    ]);

    const result = await checkUserCredentials(db, auth, "alice", "wrong", sql);

    expect(result).toEqual({ valid: false, role: null, claims: null });
  });

  it("rejects unsafe schema identifier", async () => {
    const sql = selectingSQL([]);
    const evil = {
      schema: "auth`; DROP TABLE users--",
      databaseEntity: dbMySQL,
    } as unknown as Auth;

    await expect(checkUserCredentials(db, evil, "alice", "correct-horse", sql)).rejects.toThrow();
  });
});

describe("mysql listAuthUsers", () => {
  it("reads a page and the total over one filter, every value bound", async () => {
    const calls: { query: string; params: unknown[] }[] = [];
    const sql = {
      unsafe: async (query: string, params: unknown[] = []) => {
        calls.push({ query, params });
        return query.startsWith("SELECT COUNT(*)")
          ? [{ total: 52 }]
          : [
              { username: "ada", role: "editor", is_active: 1 },
              { username: "bob", role: "editor", is_active: 0 },
            ];
      },
    } as unknown as SQL;

    expect(
      await listAuthUsers(auth, { search: "a_", role: "editor", offset: 50, limit: 50 }, sql),
    ).toEqual({
      users: [
        { username: "ada", role: "editor", isActive: true },
        { username: "bob", role: "editor", isActive: false },
      ],
      total: 52,
    });
    const from =
      "FROM `auth`.`user` WHERE LOWER(username) LIKE LOWER(?) ESCAPE '!' AND (role = ? OR ? = '')";
    expect(calls).toEqual([
      {
        query: `SELECT username, role, is_active ${from} ORDER BY username LIMIT ? OFFSET ?`,
        params: ["%a!_%", "editor", "editor", 50, 50],
      },
      { query: `SELECT COUNT(*) AS total ${from}`, params: ["%a!_%", "editor", "editor"] },
    ]);
  });
});

const recordingRowsSQL = (
  rows: unknown[],
): { sql: SQL; calls: { query: string; params: unknown[] }[] } => {
  const calls: { query: string; params: unknown[] }[] = [];
  const sql = {
    unsafe: async (query: string, params: unknown[] = []) => {
      calls.push({ query, params });
      return rows;
    },
  };
  return { sql: sql as unknown as SQL, calls };
};

describe("mysql user mutations", () => {
  it("reads one user by username, without its password", async () => {
    const { sql, calls } = recordingRowsSQL([{ username: "ada", role: "editor", is_active: 1 }]);

    expect(await getAuthUser(auth, "ada", sql)).toEqual({
      username: "ada",
      role: "editor",
      isActive: true,
    });
    expect(calls).toEqual([
      {
        query: "SELECT username, role, is_active FROM `auth`.`user` WHERE username = ?",
        params: ["ada"],
      },
    ]);
  });

  it("returns null when no user matches", async () => {
    const { sql } = recordingRowsSQL([]);

    expect(await getAuthUser(auth, "nobody", sql)).toBeNull();
  });

  it("replaces role and claims, leaving the password alone", async () => {
    const { sql, calls } = recordingRowsSQL([]);

    await updateAuthUser(auth, { username: "ada", role: "editor", claims: { a: 1 } }, sql);

    expect(calls).toEqual([
      {
        query: "UPDATE `auth`.`user` SET role = ?, claims = ? WHERE username = ?",
        params: ["editor", '{"a":1}', "ada"],
      },
    ]);
  });

  it("sets the active flag", async () => {
    const { sql, calls } = recordingRowsSQL([]);

    await setAuthUserActive(auth, { username: "ada", isActive: false }, sql);

    expect(calls).toEqual([
      {
        query: "UPDATE `auth`.`user` SET is_active = ? WHERE username = ?",
        params: [false, "ada"],
      },
    ]);
  });

  it("deletes the user", async () => {
    const { sql, calls } = recordingRowsSQL([]);

    await deleteAuthUser(auth, "ada", sql);

    expect(calls).toEqual([
      { query: "DELETE FROM `auth`.`user` WHERE username = ?", params: ["ada"] },
    ]);
  });

  it("stores a new argon2id password, never the plain text", async () => {
    const { sql, calls } = recordingRowsSQL([]);

    await resetAuthUserPassword(auth, { username: "ada", password: "another-horse" }, sql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe("UPDATE `auth`.`user` SET password = ? WHERE username = ?");
    expect(calls[0].params[1]).toBe("ada");

    const hashed = calls[0].params[0] as string;
    expect(hashed).not.toBe("another-horse");
    expect(hashed.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("another-horse", hashed)).toBe(true);
  });

  it.each([
    ["getAuthUser", (evil: Auth, sql: SQL) => getAuthUser(evil, "ada", sql)],
    [
      "updateAuthUser",
      (evil: Auth, sql: SQL) =>
        updateAuthUser(evil, { username: "ada", role: "editor", claims: {} }, sql),
    ],
    [
      "setAuthUserActive",
      (evil: Auth, sql: SQL) => setAuthUserActive(evil, { username: "ada", isActive: true }, sql),
    ],
    ["deleteAuthUser", (evil: Auth, sql: SQL) => deleteAuthUser(evil, "ada", sql)],
    [
      "resetAuthUserPassword",
      (evil: Auth, sql: SQL) =>
        resetAuthUserPassword(evil, { username: "ada", password: "p" }, sql),
    ],
  ])("refuses an unsafe schema identifier in %s", async (_name, call) => {
    const { sql } = recordingRowsSQL([]);
    const evil = {
      schema: "auth`; DROP TABLE users--",
      databaseEntity: dbMySQL,
    } as unknown as Auth;

    await expect(call(evil, sql)).rejects.toThrow();
  });
});

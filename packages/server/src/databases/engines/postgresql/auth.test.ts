import { beforeAll, describe, expect, it } from "bun:test";

import type { SQL } from "bun";
import type { Auth, Database } from "../../../types/configuration";

import { dbPostgreSQL } from "../../../__test/dbMocks";
import { hashPassword, verifyPassword } from "../../auth/password";
import { checkUserCredentials, insertAuthUser } from "./auth";

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

const auth = {
  schema: "auth",
  databaseEntity: dbPostgreSQL,
} as unknown as Auth;
const db = dbPostgreSQL satisfies Database;

describe("postgresql insertAuthUser", () => {
  it("inserts argon2id-hashed user with $1..$4 placeholders", async () => {
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

    expect(call.query).toContain('auth."user"');
    expect(call.query).toContain("$1");
    expect(call.query).toContain("$4::jsonb");

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
      schema: 'auth"; DROP TABLE users--',
      databaseEntity: dbPostgreSQL,
    } as unknown as Auth;

    await expect(
      insertAuthUser(evil, { username: "x", password: "p", role: "r" }, sql),
    ).rejects.toThrow();
  });
});

describe("postgresql checkUserCredentials", () => {
  let validHash: string;

  beforeAll(async () => {
    validHash = await hashPassword("correct-horse");
  });

  it("returns valid + role + parsed claims for a matching login", async () => {
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

  it("returns invalid when no rows match (unknown user / inactive)", async () => {
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
      schema: 'auth"; DROP TABLE users--',
      databaseEntity: dbPostgreSQL,
    } as unknown as Auth;

    await expect(checkUserCredentials(db, evil, "alice", "correct-horse", sql)).rejects.toThrow();
  });
});

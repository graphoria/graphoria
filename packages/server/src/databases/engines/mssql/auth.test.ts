import { beforeAll, describe, expect, it } from "bun:test";

import type { ConnectionPool } from "mssql";
import type { Auth, Database } from "../../../types/configuration";

import { hashPassword, verifyPassword } from "../../auth/password";
import { dbMSSQL } from "../../../__test/dbMocks";
import { checkUserCredentials, insertAuthUser } from "./auth";

type Recordset = Array<{
  username: string;
  password: string;
  role: string;
  is_active: boolean;
  claims: string | null;
}>;

const fakePool = (recordset: Recordset): ConnectionPool => {
  const request: {
    input: () => typeof request;
    query: (text: string) => Promise<{ recordset: Recordset }>;
  } = {
    input: () => request,
    query: async () => ({ recordset }),
  };
  return {
    request: () => request,
  } as unknown as ConnectionPool;
};

const auth = { schema: "auth" } as unknown as Auth;
const db = dbMSSQL satisfies Database;

let validHash: string;

beforeAll(async () => {
  validHash = await hashPassword("correct-horse");
});

describe("mssql checkUserCredentials", () => {
  it("returns parsed claims (object) when stored as JSON string", async () => {
    const pool = fakePool([
      {
        username: "alice",
        password: validHash,
        role: "admin",
        is_active: true,
        claims: JSON.stringify({ tenant: "acme", scopes: ["read", "write"] }),
      },
    ]);

    const result = await checkUserCredentials(db, auth, "alice", "correct-horse", pool);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.role).toBe("admin");
    expect(result.claims).toEqual({
      tenant: "acme",
      scopes: ["read", "write"],
    });
  });

  it("returns empty claims object when claims column is null", async () => {
    const pool = fakePool([
      {
        username: "bob",
        password: validHash,
        role: "user",
        is_active: true,
        claims: null,
      },
    ]);

    const result = await checkUserCredentials(db, auth, "bob", "correct-horse", pool);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims).toEqual({});
  });

  it("rejects login when no user matches", async () => {
    const pool = fakePool([]);

    const result = await checkUserCredentials(db, auth, "ghost", "anything", pool);

    expect(result).toEqual({ valid: false, role: null, claims: null });
  });

  it("rejects login when password does not verify", async () => {
    const pool = fakePool([
      {
        username: "alice",
        password: validHash,
        role: "admin",
        is_active: true,
        claims: "{}",
      },
    ]);

    const result = await checkUserCredentials(db, auth, "alice", "wrong", pool);

    expect(result).toEqual({ valid: false, role: null, claims: null });
  });

  it("rejects login when claims payload is malformed JSON", async () => {
    const pool = fakePool([
      {
        username: "alice",
        password: validHash,
        role: "admin",
        is_active: true,
        claims: "{not-json",
      },
    ]);

    const result = await checkUserCredentials(db, auth, "alice", "correct-horse", pool);

    expect(result).toEqual({ valid: false, role: null, claims: null });
  });

  it("throws on unsafe schema identifier", async () => {
    const pool = fakePool([]);
    const evilAuth = { schema: 'auth"; DROP TABLE users--' } as unknown as Auth;

    await expect(
      checkUserCredentials(db, evilAuth, "alice", "correct-horse", pool),
    ).rejects.toThrow();
  });
});

const recordingPool = (): {
  pool: ConnectionPool;
  calls: { query: string; inputs: Record<string, unknown> }[];
} => {
  const calls: { query: string; inputs: Record<string, unknown> }[] = [];
  const request: {
    inputs: Record<string, unknown>;
    input: (name: string, _t: unknown, value: unknown) => typeof request;
    query: (text: string) => Promise<{ recordset: [] }>;
  } = {
    inputs: {},
    input: (name, _t, value) => {
      request.inputs[name] = value;
      return request;
    },
    query: async (text) => {
      calls.push({ query: text, inputs: { ...request.inputs } });
      request.inputs = {};
      return { recordset: [] };
    },
  };
  const pool = { request: () => request } as unknown as ConnectionPool;
  return { pool, calls };
};

const authConfig = {
  schema: "auth",
  databaseEntity: dbMSSQL,
} as unknown as Auth;

describe("mssql insertAuthUser", () => {
  it("inserts argon2id-hashed user with parameterized query", async () => {
    const { pool, calls } = recordingPool();

    await insertAuthUser(
      authConfig,
      {
        username: "alice",
        password: "plain",
        role: "admin",
        claims: { tenant: "acme" },
      },
      pool,
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;

    expect(call.query).toContain("auth.[user]");
    expect(call.query).toContain("@username");
    expect(call.query).toContain("@password");
    expect(call.query).toContain("@role");
    expect(call.query).toContain("@is_active");
    expect(call.query).toContain("@claims");

    expect(call.inputs.username).toBe("alice");
    expect(call.inputs.role).toBe("admin");
    expect(call.inputs.is_active).toBe(true);
    expect(call.inputs.claims).toBe('{"tenant":"acme"}');

    const hashed = call.inputs.password as string;
    expect(hashed.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("plain", hashed)).toBe(true);
  });

  it("defaults claims to {} when omitted", async () => {
    const { pool, calls } = recordingPool();

    await insertAuthUser(authConfig, { username: "bob", password: "p", role: "user" }, pool);

    expect(calls[0].inputs.claims).toBe("{}");
  });

  it("rejects unsafe schema identifier", async () => {
    const { pool } = recordingPool();
    const evil = {
      schema: 'auth"; DROP TABLE users--',
      databaseEntity: dbMSSQL,
    } as unknown as Auth;

    await expect(
      insertAuthUser(evil, { username: "x", password: "p", role: "r" }, pool),
    ).rejects.toThrow();
  });
});

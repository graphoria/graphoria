import { CookieMap } from "bun";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";
import type { SelectionAnalysis } from "../../analyzeQuery/types";
import type { TokenService } from "../../authentication/types";
import type { Auth } from "../../types/configuration";

// `singletons/env` parses process.env at module load. Set required vars before
// any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

// oxlint-disable-next-line typescript/no-explicit-any
let handleAuthMeQuery: any;
// oxlint-disable-next-line typescript/no-explicit-any
let handleAuthMutation: any;

const fakeReq = {} as unknown as BunRequest;

beforeAll(async () => {
  ({ handleAuthMeQuery, handleAuthMutation } = await import("./gqlAuthOperations"));
});

describe("handleAuthMeQuery", () => {
  it("returns username/role for an authenticated session", () => {
    const field: SelectionAnalysis = {
      name: "auth_me",
      selections: [{ name: "username" }, { name: "role" }],
    };
    expect(handleAuthMeQuery(field, { sub: "alice", role: "user" })).toEqual({
      auth_me: { username: "alice", role: "user" },
    });
  });

  it("returns null when the session has no sub", () => {
    const field: SelectionAnalysis = { name: "auth_me" };
    expect(handleAuthMeQuery(field, undefined)).toEqual({ auth_me: null });
  });

  it("honours the field alias", () => {
    const field: SelectionAnalysis = {
      name: "auth_me",
      alias: "me",
      selections: [{ name: "username" }, { name: "role" }],
    };
    expect(handleAuthMeQuery(field, { sub: "bob", role: "admin" })).toEqual({
      me: { username: "bob", role: "admin" },
    });
  });

  it("answers only the subfields the selection asks for, under their aliases", () => {
    const field: SelectionAnalysis = {
      name: "auth_me",
      selections: [{ name: "username", alias: "name" }],
    };
    expect(handleAuthMeQuery(field, { sub: "alice", role: "user" })).toEqual({
      auth_me: { name: "alice" },
    });
  });

  it("answers null for the id, which no auth user has", () => {
    const field: SelectionAnalysis = {
      name: "auth_me",
      selections: [{ name: "id" }, { name: "username" }],
    };
    expect(handleAuthMeQuery(field, { sub: "alice", role: "user" })).toEqual({
      auth_me: { id: null, username: "alice" },
    });
  });

  it("names the user type when the selection asks for __typename", () => {
    const field: SelectionAnalysis = {
      name: "auth_me",
      selections: [
        { name: "__typename", typeName: "AuthUser" },
        { name: "__typename", alias: "kind", typeName: "AuthUser" },
        { name: "username" },
      ],
    };
    expect(handleAuthMeQuery(field, { sub: "alice", role: "user" })).toEqual({
      auth_me: { __typename: "AuthUser", kind: "AuthUser", username: "alice" },
    });
    expect(handleAuthMeQuery(field, undefined)).toEqual({ auth_me: null });
  });

  it("returns an empty object for non auth_me fields", () => {
    const field: SelectionAnalysis = { name: "something_else" };
    expect(handleAuthMeQuery(field, { sub: "x", role: "user" })).toEqual({});
  });
});

describe("handleAuthMutation — enabled guard", () => {
  it("throws when auth is disabled", () => {
    const field: SelectionAnalysis = {
      name: "auth_login",
      arguments: { username: "a", password: "b" },
    };
    expect(
      handleAuthMutation(field, {}, { enabled: false } as Auth, fakeReq, undefined),
    ).rejects.toThrow("Authentication is not enabled");
  });

  it("throws when auth is null", () => {
    const field: SelectionAnalysis = {
      name: "auth_login",
      arguments: { username: "a", password: "b" },
    };
    expect(handleAuthMutation(field, {}, null, fakeReq, undefined)).rejects.toThrow(
      "Authentication is not enabled",
    );
  });
});

describe("handleAuthMutation — the payload", () => {
  // A connection of this file's own, so the login checks a real user table.
  const DATABASE = "gql-auth-operations-test";
  const auth = {
    enabled: true,
    schema: "main",
    databaseEntity: { name: DATABASE, type: "sqlite" },
  } as Auth;
  const db = new SQLiteDatabase(":memory:");
  let tokens: TokenService;
  let previousTokens: TokenService;
  // oxlint-disable-next-line typescript/no-explicit-any
  let setTokenService: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let setAuditLog: any;
  // oxlint-disable-next-line typescript/no-explicit-any
  let databasesConnections: any;

  beforeAll(async () => {
    const { insertAuthUser, userTableCreation } =
      await import("../../databases/engines/sqlite/auth");
    const { createJWTService } = await import("../../authentication/jwt");
    const { env } = await import("../../singletons/env");
    const authentication = await import("../../singletons/authentication");
    ({ databasesConnections } = await import("../../singletons/databases"));
    ({ setAuditLog } = await import("../../logging/audit"));
    setTokenService = authentication.setTokenService;

    db.run(userTableCreation("main"));
    databasesConnections[DATABASE] = db;
    await insertAuthUser(auth, { username: "alice", password: "alice-password", role: "user" }, db);

    previousTokens = authentication.getTokenService();
    tokens = createJWTService({
      ...env,
      jwt: { secrets: ["gql-auth-operations-test"], expiresIn: "5m", rtExpiresIn: "7d" },
    });
    setTokenService(tokens);
    setAuditLog({ emit: () => {} });
  });

  afterAll(() => {
    setAuditLog(null);
    setTokenService(previousTokens);
    delete databasesConnections[DATABASE];
    db.close();
  });

  const login = (selections: SelectionAnalysis[]): SelectionAnalysis => ({
    name: "auth_login",
    arguments: { username: "alice", password: "alice-password" },
    selections,
  });

  it("answers only the auth_login subfields the selection asks for", async () => {
    expect(await handleAuthMutation(login([{ name: "access_token" }]), {}, auth)).toEqual({
      data: { auth_login: { access_token: expect.any(String) } },
    });
  });

  it("answers an auth_login subfield under its alias", async () => {
    expect(
      await handleAuthMutation(
        login([{ name: "access_token", alias: "token" }, { name: "role" }]),
        {},
        auth,
      ),
    ).toEqual({ data: { auth_login: { token: expect.any(String), role: "user" } } });
  });

  it("answers only the auth_refresh subfields the selection asks for, under their aliases", async () => {
    const { refresh_token } = await tokens.createTokenPair({ sub: "alice", role: "user" });
    const req = { cookies: new CookieMap({ refresh_token }) } as unknown as BunRequest;

    expect(
      await handleAuthMutation(
        { name: "auth_refresh", selections: [{ name: "expires_in", alias: "ttl" }] },
        {},
        auth,
        req,
      ),
    ).toEqual({ data: { auth_refresh: { ttl: 300 } } });
  });
});

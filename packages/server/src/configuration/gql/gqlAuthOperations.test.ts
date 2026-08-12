import { beforeAll, describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";
import type { SelectionAnalysis } from "../../analyzeQuery/types";
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
    const field: SelectionAnalysis = { name: "auth_me" };
    expect(handleAuthMeQuery(field, { sub: "alice", role: "user" })).toEqual({
      auth_me: { username: "alice", role: "user" },
    });
  });

  it("returns null when the session has no sub", () => {
    const field: SelectionAnalysis = { name: "auth_me" };
    expect(handleAuthMeQuery(field, undefined)).toEqual({ auth_me: null });
  });

  it("honours the field alias", () => {
    const field: SelectionAnalysis = { name: "auth_me", alias: "me" };
    expect(handleAuthMeQuery(field, { sub: "bob", role: "admin" })).toEqual({
      me: { username: "bob", role: "admin" },
    });
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

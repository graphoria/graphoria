import { describe, expect, it } from "bun:test";

import {
  AuthUserExistsError,
  AuthUserProtectedError,
  parseAuthUserActiveInput,
  parseAuthUserInput,
  parseAuthUserPasswordInput,
  parseAuthUserUpdateInput,
  parseAuthUsername,
  userRoles,
} from "./users";

const valid = { username: "ada", password: "correct-horse", role: "editor" };

describe("parseAuthUserInput", () => {
  it("passes a valid user through, claims defaulting to {}", () => {
    expect(parseAuthUserInput(valid)).toEqual({ ...valid, claims: {} });
  });

  it("keeps claims that are a JSON object", () => {
    expect(parseAuthUserInput({ ...valid, claims: { organizationId: 7 } }).claims).toEqual({
      organizationId: 7,
    });
  });

  it("takes a 50-character username, an email and an 8-character password", () => {
    expect(() => parseAuthUserInput({ ...valid, username: "a".repeat(50) })).not.toThrow();
    expect(() => parseAuthUserInput({ ...valid, username: "ada@example.com" })).not.toThrow();
    expect(() => parseAuthUserInput({ ...valid, password: "12345678" })).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["51 characters long", "a".repeat(51)],
    ["led by a space", " ada"],
    ["trailed by a space", "ada "],
    ["not a string", 42],
  ])("rejects a username %s", (_what, username) => {
    expect(() => parseAuthUserInput({ ...valid, username })).toThrow(
      "username must be 1 to 50 characters, without leading or trailing spaces",
    );
  });

  it.each([
    ["7 characters long", "1234567"],
    ["missing", undefined],
  ])("rejects a password %s", (_what, password) => {
    expect(() => parseAuthUserInput({ ...valid, password })).toThrow(
      "password must be at least 8 characters",
    );
  });

  it.each([
    ["empty", ""],
    ["21 characters long", "r".repeat(21)],
    ["not a string", ["editor"]],
  ])("rejects a role %s", (_what, role) => {
    expect(() => parseAuthUserInput({ ...valid, role })).toThrow("role must be 1 to 20 characters");
  });

  it.each([
    ["an array", ["x"]],
    ["null", null],
    ["a string", "{}"],
  ])("rejects claims that are %s", (_what, claims) => {
    expect(() => parseAuthUserInput({ ...valid, claims })).toThrow("claims must be a JSON object");
  });

  it("answers a null or missing body with the username rule", () => {
    expect(() => parseAuthUserInput(null)).toThrow(
      "username must be 1 to 50 characters, without leading or trailing spaces",
    );
    expect(() => parseAuthUserInput(undefined)).toThrow(
      "username must be 1 to 50 characters, without leading or trailing spaces",
    );
  });
});

describe("parseAuthUsername", () => {
  it("keeps a username rule of its own, shared by every parser", () => {
    expect(parseAuthUsername("ada@example.com")).toBe("ada@example.com");
    expect(() => parseAuthUsername(" ada")).toThrow(
      "username must be 1 to 50 characters, without leading or trailing spaces",
    );
  });
});

describe("parseAuthUserUpdateInput", () => {
  it("replaces role and claims, claims defaulting to {}", () => {
    expect(parseAuthUserUpdateInput({ username: "ada", role: "editor" })).toEqual({
      username: "ada",
      role: "editor",
      claims: {},
    });
    expect(
      parseAuthUserUpdateInput({ username: "ada", role: "editor", claims: { a: 1 } }).claims,
    ).toEqual({ a: 1 });
  });

  it.each([
    ["empty", ""],
    ["21 characters long", "r".repeat(21)],
    ["not a string", 7],
  ])("rejects an update role that is %s", (_what, role) => {
    expect(() => parseAuthUserUpdateInput({ username: "ada", role })).toThrow(
      "role must be 1 to 20 characters",
    );
  });

  it("rejects claims that are not a JSON object", () => {
    expect(() => parseAuthUserUpdateInput({ username: "ada", role: "editor", claims: [] })).toThrow(
      "claims must be a JSON object",
    );
  });
});

describe("parseAuthUserPasswordInput", () => {
  it("requires 8 characters to reset a password", () => {
    expect(parseAuthUserPasswordInput({ username: "ada", password: "12345678" })).toEqual({
      username: "ada",
      password: "12345678",
    });
    expect(() => parseAuthUserPasswordInput({ username: "ada", password: "1234567" })).toThrow(
      "password must be at least 8 characters",
    );
  });
});

describe("parseAuthUserActiveInput", () => {
  it.each([[true], [false]])("takes isActive %s", (isActive) => {
    expect(parseAuthUserActiveInput({ username: "ada", isActive })).toEqual({
      username: "ada",
      isActive,
    });
  });

  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["missing", undefined],
  ])("rejects isActive that is %s", (_what, isActive) => {
    expect(() => parseAuthUserActiveInput({ username: "ada", isActive })).toThrow(
      "isActive must be true or false",
    );
  });
});

describe("AuthUserProtectedError", () => {
  it("names the user in the protected-user error", () => {
    expect(new AuthUserProtectedError("ada").message).toBe(
      'User "ada" holds the superadmin role, which the console does not manage',
    );
  });
});

describe("userRoles", () => {
  const env = { anonymousRole: "anonymous", superadmin: { role: "superadmin" } };

  it("lists every permission role but the anonymous one, then the superadmin role once", () => {
    const permissions = { anonymous: {}, reader: {}, superadmin: {}, editor: {} };

    expect(userRoles({ permissions }, env)).toEqual(["reader", "editor", "superadmin"]);
  });
});

describe("AuthUserExistsError", () => {
  it("is an Error that names the username", () => {
    const error = new AuthUserExistsError("ada");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('User "ada" already exists');
  });
});

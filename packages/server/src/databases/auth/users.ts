import type {
  InsertAuthUserInput,
  ResetAuthUserPasswordInput,
  SetAuthUserActiveInput,
  UpdateAuthUserInput,
} from "../core/function-mapping";

// The auth user table's VARCHAR(50) username and VARCHAR(20) role, on every
// engine: SQLite alone would store a longer value instead of refusing it.
export const AUTH_USERNAME_MAX_LENGTH = 50;
export const AUTH_ROLE_MAX_LENGTH = 20;
export const AUTH_PASSWORD_MIN_LENGTH = 8;

export class AuthUserExistsError extends Error {
  constructor(username: string) {
    super(`User "${username}" already exists`);
    this.name = "AuthUserExistsError";
  }
}

export class AuthUserProtectedError extends Error {
  constructor(username: string) {
    super(`User "${username}" holds the superadmin role, which the console does not manage`);
    this.name = "AuthUserProtectedError";
  }
}

export const parseAuthUsername = (input: unknown): string => {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > AUTH_USERNAME_MAX_LENGTH ||
    input.trim() !== input
  )
    throw new Error(
      `username must be 1 to ${AUTH_USERNAME_MAX_LENGTH} characters, without leading or trailing spaces`,
    );
  return input;
};

const parseAuthPassword = (password: unknown): string => {
  if (typeof password !== "string" || password.length < AUTH_PASSWORD_MIN_LENGTH)
    throw new Error(`password must be at least ${AUTH_PASSWORD_MIN_LENGTH} characters`);
  return password;
};

const parseAuthRole = (role: unknown): string => {
  if (typeof role !== "string" || role.length === 0 || role.length > AUTH_ROLE_MAX_LENGTH)
    throw new Error(`role must be 1 to ${AUTH_ROLE_MAX_LENGTH} characters`);
  return role;
};

const parseAuthClaims = (claims: unknown): Record<string, unknown> => {
  if (
    claims !== undefined &&
    (typeof claims !== "object" || claims === null || Array.isArray(claims))
  )
    throw new Error("claims must be a JSON object");
  return (claims ?? {}) as Record<string, unknown>;
};

// A signed-in user holds a role of auth.permissions or the superadmin role,
// never the anonymous one: that is what a caller without a token reads as.
export const userRoles = (
  auth: { permissions: Record<string, unknown> },
  env: { anonymousRole: string; superadmin: { role: string } },
): string[] => [
  ...Object.keys(auth.permissions).filter(
    (role) => role !== env.anonymousRole && role !== env.superadmin.role,
  ),
  env.superadmin.role,
];

export const parseAuthUserInput = (input: unknown): InsertAuthUserInput => {
  // A JSON body of null has no fields to read: the rules below answer for it.
  const { username, password, role, claims } = (input ?? {}) as {
    username?: unknown;
    password?: unknown;
    role?: unknown;
    claims?: unknown;
  };
  return {
    username: parseAuthUsername(username),
    password: parseAuthPassword(password),
    role: parseAuthRole(role),
    claims: parseAuthClaims(claims),
  };
};

export const parseAuthUserUpdateInput = (input: unknown): UpdateAuthUserInput => {
  const { username, role, claims } = (input ?? {}) as {
    username?: unknown;
    role?: unknown;
    claims?: unknown;
  };
  return {
    username: parseAuthUsername(username),
    role: parseAuthRole(role),
    claims: parseAuthClaims(claims),
  };
};

export const parseAuthUserPasswordInput = (input: unknown): ResetAuthUserPasswordInput => {
  const { username, password } = (input ?? {}) as { username?: unknown; password?: unknown };
  return {
    username: parseAuthUsername(username),
    password: parseAuthPassword(password),
  };
};

export const parseAuthUserActiveInput = (input: unknown): SetAuthUserActiveInput => {
  const { username, isActive } = (input ?? {}) as { username?: unknown; isActive?: unknown };
  const parsedUsername = parseAuthUsername(username);
  if (typeof isActive !== "boolean") throw new Error("isActive must be true or false");
  return { username: parsedUsername, isActive };
};

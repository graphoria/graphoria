import type { AuthUserSummary } from "../../core/function-mapping";

export type AuthUserRow = { username: string; role: string; is_active: unknown };

// Every engine's statement declares ESCAPE '!': the pattern escapes `!` itself,
// LIKE's `%` and `_`, and the `[` T-SQL reads as the start of a set.
export const containsPattern = (search: string) => `%${search.replace(/[!%_[]/g, "!$&")}%`;

// PostgreSQL and MSSQL hand is_active back as a boolean, MySQL and SQLite as 1
// or 0, and a row inserted by hand may hold NULL, which cannot log in either.
export const toAuthUserSummary = ({ username, role, is_active }: AuthUserRow): AuthUserSummary => ({
  username,
  role,
  isActive: Boolean(Number(is_active)),
});

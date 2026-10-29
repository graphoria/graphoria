import type { SQL } from "bun";
import type { Auth, Database } from "../../../types/configuration";
import type {
  AuthUserPage,
  AuthUserSummary,
  CheckUserCredentialsResult,
  InsertAuthUserInput,
  ListAuthUsersInput,
  ResetAuthUserPasswordInput,
  SetAuthUserActiveInput,
  UpdateAuthUserInput,
} from "../../core/function-mapping";

import { databasesConnections } from "../../../singletons/databases";
import { hashPassword, verifyPassword } from "../../auth/password";
import { AuthUserExistsError } from "../../auth/users";
import { assertSafeIdentifier } from "../../core/identifier";
import { generateSchemaCreationPostgreSQL } from "../../schemaBuilder/generateSchemaCreation";
import { parseUserClaims } from "../shared/claims";
import type { UserRecord } from "../shared/types";
import type { AuthUserRow } from "../shared/users";
import { containsPattern, toAuthUserSummary } from "../shared/users";

export const userTableCreation = (schema: string) => `
    CREATE TABLE IF NOT EXISTS ${assertSafeIdentifier(schema, "schema")}."user" (
        username VARCHAR(50) PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        claims JSONB DEFAULT '{}'
    );
`;

export const createAuthTables = async (auth: Auth) => {
  const pool = databasesConnections[auth.databaseEntity.name] as SQL;

  await pool.unsafe(generateSchemaCreationPostgreSQL(auth.schema!, true));

  await pool.unsafe(userTableCreation(auth.schema!));
};

export const checkUserCredentials = async (
  db: Database,
  auth: Auth,
  username: string,
  password: string,
  injectedPool?: SQL,
): Promise<CheckUserCredentialsResult> => {
  const pool = injectedPool ?? (databasesConnections[db.name] as SQL);

  const schema = assertSafeIdentifier(auth.schema!, "schema");

  const result: UserRecord[] = await pool.unsafe(
    `SELECT * FROM ${schema}."user" WHERE username = $1 AND is_active = TRUE`,
    [username],
  );

  if (result?.length === 0) {
    return {
      valid: false,
      role: null,
      claims: null,
    };
  }

  const { password: hashedPassword, role, claims } = result[0];

  if (!(await verifyPassword(password, hashedPassword))) {
    return {
      valid: false,
      role: null,
      claims: null,
    };
  }

  const parsedClaims = parseUserClaims(claims);

  if (parsedClaims === null) {
    return {
      valid: false,
      role: null,
      claims: null,
    };
  }

  return { valid: true, role, claims: parsedClaims };
};

export const verifyAuthTablesExist = async (auth: Auth, injectedPool?: SQL): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  await pool.unsafe(`SELECT username FROM ${schema}."user" WHERE 1=0`);
};

export const insertAuthUser = async (
  auth: Auth,
  input: InsertAuthUserInput,
  injectedPool?: SQL,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);

  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(input.password);

  try {
    await pool.unsafe(
      `INSERT INTO ${schema}."user" (username, password, role, is_active, claims)
       VALUES ($1, $2, $3, TRUE, $4::jsonb)`,
      [input.username, hashed, input.role, JSON.stringify(input.claims ?? {})],
    );
  } catch (error) {
    // SQLSTATE 23505, unique_violation: username is the primary key.
    if ((error as { errno?: unknown } | null)?.errno === "23505")
      throw new AuthUserExistsError(input.username);
    throw error;
  }
};

export const listAuthUsers = async (
  auth: Auth,
  { search, role, offset, limit }: ListAuthUsersInput,
  injectedPool?: SQL,
): Promise<AuthUserPage> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const from = `FROM ${schema}."user" WHERE LOWER(username) LIKE LOWER($1) ESCAPE '!' AND (role = $2 OR $2 = '')`;
  const filter = [containsPattern(search), role];

  const [rows, [count]] = await Promise.all([
    pool.unsafe<AuthUserRow[]>(
      `SELECT username, role, is_active ${from} ORDER BY username LIMIT $3 OFFSET $4`,
      [...filter, limit, offset],
    ),
    pool.unsafe<{ total: unknown }[]>(`SELECT COUNT(*) AS total ${from}`, filter),
  ]);

  return { users: rows.map(toAuthUserSummary), total: Number(count.total) };
};

export const getAuthUser = async (
  auth: Auth,
  username: string,
  injectedPool?: SQL,
): Promise<AuthUserSummary | null> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  const rows = await pool.unsafe<AuthUserRow[]>(
    `SELECT username, role, is_active FROM "${schema}"."user" WHERE username = $1`,
    [username],
  );

  return rows[0] ? toAuthUserSummary(rows[0]) : null;
};

export const updateAuthUser = async (
  auth: Auth,
  { username, role, claims }: UpdateAuthUserInput,
  injectedPool?: SQL,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  await pool.unsafe(
    `UPDATE "${schema}"."user" SET role = $2, claims = $3::jsonb WHERE username = $1`,
    [username, role, JSON.stringify(claims)],
  );
};

export const setAuthUserActive = async (
  auth: Auth,
  { username, isActive }: SetAuthUserActiveInput,
  injectedPool?: SQL,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  await pool.unsafe(`UPDATE "${schema}"."user" SET is_active = $2 WHERE username = $1`, [
    username,
    isActive,
  ]);
};

export const deleteAuthUser = async (
  auth: Auth,
  username: string,
  injectedPool?: SQL,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  await pool.unsafe(`DELETE FROM "${schema}"."user" WHERE username = $1`, [username]);
};

export const resetAuthUserPassword = async (
  auth: Auth,
  { username, password }: ResetAuthUserPasswordInput,
  injectedPool?: SQL,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(password);

  await pool.unsafe(`UPDATE "${schema}"."user" SET password = $2 WHERE username = $1`, [
    username,
    hashed,
  ]);
};

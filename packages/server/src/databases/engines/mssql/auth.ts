import { BigInt, Bit, Int, MAX, NVarChar } from "mssql";

import type { ConnectionPool } from "mssql";
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
import { generateSchemaCreationMSSQL } from "../../schemaBuilder/generateSchemaCreation";
import { parseUserClaims } from "../shared/claims";
import type { AuthUserRow } from "../shared/users";
import { containsPattern, toAuthUserSummary } from "../shared/users";

export const userTableCreation = (schema: string) => `
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${assertSafeIdentifier(schema, "schema")}' AND TABLE_NAME = 'user')
    BEGIN
        CREATE TABLE ${schema}.[user] (
            username NVARCHAR(50) PRIMARY KEY,
            password NVARCHAR(255) NOT NULL,
            role NVARCHAR(20) NOT NULL,
            is_active BIT DEFAULT 1,
            claims NVARCHAR(MAX) DEFAULT '{}',
        );
    END
`;

export const createAuthTables = async (auth: Auth) => {
  const pool = databasesConnections[auth.databaseEntity.name] as ConnectionPool;

  await pool.query(generateSchemaCreationMSSQL(auth.schema!, true));

  await pool.query(userTableCreation(auth.schema!));
};

export const checkUserCredentials = async (
  db: Database,
  auth: Auth,
  username: string,
  password: string,
  injectedPool?: ConnectionPool,
): Promise<CheckUserCredentialsResult> => {
  const pool = injectedPool ?? (databasesConnections[db.name] as ConnectionPool);

  const schema = assertSafeIdentifier(auth.schema!, "schema");

  const request = pool.request().input("username", NVarChar(50), username);

  const result = await request.query(
    `SELECT * FROM ${schema}.[user] WHERE username = @username AND is_active = 1`,
  );

  if (result.recordset?.length === 0) {
    return {
      valid: false,
      role: null,
      claims: null,
    };
  }

  const { password: hashedPassword, role, claims } = result.recordset[0];

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

export const verifyAuthTablesExist = async (
  auth: Auth,
  injectedPool?: ConnectionPool,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  await pool.request().query(`SELECT username FROM ${schema}.[user] WHERE 1=0`);
};

export const insertAuthUser = async (
  auth: Auth,
  input: InsertAuthUserInput,
  injectedPool?: ConnectionPool,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);

  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(input.password);

  try {
    await pool
      .request()
      .input("username", NVarChar(50), input.username)
      .input("password", NVarChar(255), hashed)
      .input("role", NVarChar(20), input.role)
      .input("is_active", Bit, true)
      .input("claims", NVarChar(MAX), JSON.stringify(input.claims ?? {}))
      .query(
        `INSERT INTO ${schema}.[user] (username, password, role, is_active, claims)
         VALUES (@username, @password, @role, @is_active, @claims)`,
      );
  } catch (error) {
    // 2627: a primary key or unique constraint; 2601: a unique index, on a table made by hand.
    const number = (error as { number?: unknown } | null)?.number;
    if (number === 2627 || number === 2601) throw new AuthUserExistsError(input.username);
    throw error;
  }
};

export const listAuthUsers = async (
  auth: Auth,
  { search, role, offset, limit }: ListAuthUsersInput,
  injectedPool?: ConnectionPool,
): Promise<AuthUserPage> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const from = `FROM ${schema}.[user] WHERE LOWER(username) LIKE LOWER(@pattern) ESCAPE '!' AND (role = @role OR @role = '')`;
  const filtered = () =>
    pool
      .request()
      .input("pattern", NVarChar(MAX), containsPattern(search))
      .input("role", NVarChar(MAX), role);

  const [page, count] = await Promise.all([
    filtered()
      .input("offset", BigInt, offset)
      .input("limit", Int, limit)
      .query<AuthUserRow>(
        `SELECT username, role, is_active ${from} ORDER BY username OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      ),
    filtered().query<{ total: number }>(`SELECT COUNT(*) AS total ${from}`),
  ]);

  return {
    users: page.recordset.map(toAuthUserSummary),
    total: Number(count.recordset[0]!.total),
  };
};

export const getAuthUser = async (
  auth: Auth,
  username: string,
  injectedPool?: ConnectionPool,
): Promise<AuthUserSummary | null> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  const result = await pool
    .request()
    .input("username", NVarChar(50), username)
    .query<AuthUserRow>(
      `SELECT username, role, is_active FROM ${schema}.[user] WHERE username = @username`,
    );

  const row = result.recordset[0];
  return row ? toAuthUserSummary(row) : null;
};

export const updateAuthUser = async (
  auth: Auth,
  { username, role, claims }: UpdateAuthUserInput,
  injectedPool?: ConnectionPool,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  await pool
    .request()
    .input("username", NVarChar(50), username)
    .input("role", NVarChar(20), role)
    .input("claims", NVarChar(MAX), JSON.stringify(claims))
    .query(`UPDATE ${schema}.[user] SET role = @role, claims = @claims WHERE username = @username`);
};

export const setAuthUserActive = async (
  auth: Auth,
  { username, isActive }: SetAuthUserActiveInput,
  injectedPool?: ConnectionPool,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  await pool
    .request()
    .input("username", NVarChar(50), username)
    .input("is_active", Bit, isActive)
    .query(`UPDATE ${schema}.[user] SET is_active = @is_active WHERE username = @username`);
};

export const deleteAuthUser = async (
  auth: Auth,
  username: string,
  injectedPool?: ConnectionPool,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  await pool
    .request()
    .input("username", NVarChar(50), username)
    .query(`DELETE FROM ${schema}.[user] WHERE username = @username`);
};

export const resetAuthUserPassword = async (
  auth: Auth,
  { username, password }: ResetAuthUserPasswordInput,
  injectedPool?: ConnectionPool,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as ConnectionPool);
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(password);

  await pool
    .request()
    .input("username", NVarChar(50), username)
    .input("password", NVarChar(255), hashed)
    .query(`UPDATE ${schema}.[user] SET password = @password WHERE username = @username`);
};

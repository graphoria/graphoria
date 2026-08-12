import { Bit, MAX, NVarChar } from "mssql";

import type { ConnectionPool } from "mssql";
import type { Auth, Database } from "../../../types/configuration";
import type { CheckUserCredentialsResult, InsertAuthUserInput } from "../../core/function-mapping";

import { databasesConnections } from "../../../singletons/databases";
import { hashPassword, verifyPassword } from "../../auth/password";
import { assertSafeIdentifier } from "../../core/identifier";
import { generateSchemaCreationMSSQL } from "../../schemaBuilder/generateSchemaCreation";
import { parseUserClaims } from "../shared/claims";

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
};

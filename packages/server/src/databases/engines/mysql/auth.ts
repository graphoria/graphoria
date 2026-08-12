import type { SQL } from "bun";
import type { Auth, Database } from "../../../types/configuration";
import type { CheckUserCredentialsResult, InsertAuthUserInput } from "../../core/function-mapping";

import { databasesConnections } from "../../../singletons/databases";
import { hashPassword, verifyPassword } from "../../auth/password";
import { assertSafeIdentifier } from "../../core/identifier";
import { parseUserClaims } from "../shared/claims";
import type { UserRecord } from "../shared/types";

export const userTableCreation = (schema: string) => `
    CREATE TABLE IF NOT EXISTS \`${assertSafeIdentifier(schema, "schema")}\`.\`user\` (
        username VARCHAR(50) PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        claims JSON DEFAULT ('{}')
    );
`;

export const createAuthTables = async (auth: Auth) => {
  const pool = databasesConnections[auth.databaseEntity.name] as SQL;

  const schema = assertSafeIdentifier(auth.schema!, "schema");

  // In MySQL, CREATE DATABASE is used instead of CREATE SCHEMA
  await pool.unsafe(`CREATE DATABASE IF NOT EXISTS \`${schema}\`;`);

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

  const result = await pool.unsafe<UserRecord[]>(
    `SELECT * FROM \`${schema}\`.\`user\` WHERE username = $1 AND is_active = TRUE`,
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
  await pool.unsafe(`SELECT username FROM \`${schema}\`.\`user\` WHERE 1=0`);
};

export const insertAuthUser = async (
  auth: Auth,
  input: InsertAuthUserInput,
  injectedPool?: SQL,
): Promise<void> => {
  const pool = injectedPool ?? (databasesConnections[auth.databaseEntity.name] as SQL);

  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(input.password);

  await pool.unsafe(
    `INSERT INTO \`${schema}\`.\`user\` (username, password, role, is_active, claims)
       VALUES ($1, $2, $3, TRUE, $4)`,
    [input.username, hashed, input.role, JSON.stringify(input.claims ?? {})],
  );
};

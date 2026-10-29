import type { Database as SQLiteDatabase } from "bun:sqlite";
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
import type { UserRecord } from "../shared/types";

import { databasesConnections } from "../../../singletons/databases";
import { hashPassword, verifyPassword } from "../../auth/password";
import { AuthUserExistsError } from "../../auth/users";
import { assertSafeIdentifier } from "../../core/identifier";
import { parseUserClaims } from "../shared/claims";
import type { AuthUserRow } from "../shared/users";
import { containsPattern, toAuthUserSummary } from "../shared/users";
import { schemasOf } from "./connection";

export const userTableCreation = (schema: string) => `
    CREATE TABLE IF NOT EXISTS "${assertSafeIdentifier(schema, "schema")}"."user" (
        username VARCHAR(50) NOT NULL PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        claims TEXT DEFAULT '{}'
    );
`;

const REJECTED: CheckUserCredentialsResult = { valid: false, role: null, claims: null };

const connectionOf = (name: string, injected?: SQLiteDatabase) =>
  injected ?? (databasesConnections[name] as SQLiteDatabase);

// A SQLite schema is a file attached at connect time, which SQL cannot create,
// and an unattached schema otherwise fails later with a bare "no such table".
// Name the fix up front wherever a schema is about to be used. SQLite matches
// schema names without regard to case, and so does this check.
const assertAuthSchemaAttached = (auth: Auth) => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const attached = (name: string) => name.toLowerCase() === schema.toLowerCase();

  if (!schemasOf(auth.databaseEntity).some(attached)) {
    throw new Error(
      `Auth schema "${schema}" is not attached to SQLite database "${auth.databaseEntity.name}": add it under connection.attach, or set auth.schema to "main"`,
    );
  }

  return schema;
};

export const createAuthTables = async (auth: Auth, injected?: SQLiteDatabase) => {
  const schema = assertAuthSchemaAttached(auth);

  connectionOf(auth.databaseEntity.name, injected).run(userTableCreation(schema));
};

export const checkUserCredentials = async (
  db: Database,
  auth: Auth,
  username: string,
  password: string,
  injected?: SQLiteDatabase,
): Promise<CheckUserCredentialsResult> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  const [user] = connectionOf(db.name, injected)
    .query(`SELECT * FROM "${schema}"."user" WHERE username = $1 AND is_active = TRUE`)
    .all({ $1: username }) as UserRecord[];

  if (!user || !(await verifyPassword(password, user.password))) return REJECTED;

  const claims = parseUserClaims(user.claims);

  return claims === null ? REJECTED : { valid: true, role: user.role, claims };
};

export const verifyAuthTablesExist = async (auth: Auth, injected?: SQLiteDatabase) => {
  const schema = assertAuthSchemaAttached(auth);

  connectionOf(auth.databaseEntity.name, injected)
    .query(`SELECT username FROM "${schema}"."user" WHERE 1=0`)
    .all();
};

export const insertAuthUser = async (
  auth: Auth,
  input: InsertAuthUserInput,
  injected?: SQLiteDatabase,
): Promise<void> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(input.password);

  try {
    connectionOf(auth.databaseEntity.name, injected)
      .query(
        `INSERT INTO "${schema}"."user" (username, password, role, is_active, claims) VALUES ($1, $2, $3, TRUE, $4)`,
      )
      .run({
        $1: input.username,
        $2: hashed,
        $3: input.role,
        $4: JSON.stringify(input.claims ?? {}),
      });
  } catch (error) {
    // The primary key, or a unique index on a table made by hand.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE")
      throw new AuthUserExistsError(input.username);
    throw error;
  }
};

export const listAuthUsers = async (
  auth: Auth,
  { search, role, offset, limit }: ListAuthUsersInput,
  injected?: SQLiteDatabase,
): Promise<AuthUserPage> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const connection = connectionOf(auth.databaseEntity.name, injected);
  const from = `FROM "${schema}"."user" WHERE LOWER(username) LIKE LOWER($1) ESCAPE '!' AND (role = $2 OR $2 = '')`;
  const filter = { $1: containsPattern(search), $2: role };

  const rows = connection
    .query(`SELECT username, role, is_active ${from} ORDER BY username LIMIT $3 OFFSET $4`)
    .all({ ...filter, $3: limit, $4: offset }) as AuthUserRow[];
  const { total } = connection.query(`SELECT COUNT(*) AS total ${from}`).get(filter) as {
    total: number;
  };

  return { users: rows.map(toAuthUserSummary), total };
};

export const getAuthUser = async (
  auth: Auth,
  username: string,
  injected?: SQLiteDatabase,
): Promise<AuthUserSummary | null> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  const row = connectionOf(auth.databaseEntity.name, injected)
    .query(`SELECT username, role, is_active FROM "${schema}"."user" WHERE username = $1`)
    .get({ $1: username }) as AuthUserRow | null;

  return row ? toAuthUserSummary(row) : null;
};

export const updateAuthUser = async (
  auth: Auth,
  { username, role, claims }: UpdateAuthUserInput,
  injected?: SQLiteDatabase,
): Promise<void> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  connectionOf(auth.databaseEntity.name, injected)
    .query(`UPDATE "${schema}"."user" SET role = $2, claims = $3 WHERE username = $1`)
    .run({ $1: username, $2: role, $3: JSON.stringify(claims) });
};

export const setAuthUserActive = async (
  auth: Auth,
  { username, isActive }: SetAuthUserActiveInput,
  injected?: SQLiteDatabase,
): Promise<void> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  connectionOf(auth.databaseEntity.name, injected)
    .query(`UPDATE "${schema}"."user" SET is_active = $2 WHERE username = $1`)
    .run({ $1: username, $2: isActive });
};

export const deleteAuthUser = async (
  auth: Auth,
  username: string,
  injected?: SQLiteDatabase,
): Promise<void> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");

  connectionOf(auth.databaseEntity.name, injected)
    .query(`DELETE FROM "${schema}"."user" WHERE username = $1`)
    .run({ $1: username });
};

export const resetAuthUserPassword = async (
  auth: Auth,
  { username, password }: ResetAuthUserPasswordInput,
  injected?: SQLiteDatabase,
): Promise<void> => {
  const schema = assertSafeIdentifier(auth.schema!, "schema");
  const hashed = await hashPassword(password);

  connectionOf(auth.databaseEntity.name, injected)
    .query(`UPDATE "${schema}"."user" SET password = $2 WHERE username = $1`)
    .run({ $1: username, $2: hashed });
};

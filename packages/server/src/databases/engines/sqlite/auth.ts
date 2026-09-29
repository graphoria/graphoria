import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { Auth, Database } from "../../../types/configuration";
import type { CheckUserCredentialsResult, InsertAuthUserInput } from "../../core/function-mapping";
import type { UserRecord } from "../shared/types";

import { databasesConnections } from "../../../singletons/databases";
import { hashPassword, verifyPassword } from "../../auth/password";
import { assertSafeIdentifier } from "../../core/identifier";
import { parseUserClaims } from "../shared/claims";
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
};

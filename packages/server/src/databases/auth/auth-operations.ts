import type { Auth } from "../../types/configuration";
import type { InsertAuthUserInput } from "../core/function-mapping";

import { databaseAdapters } from "../core/function-mapping";

/**
 * Authentication and authorization operations
 */

export const createAuthTables = async (auth: Auth) =>
  databaseAdapters[auth.databaseEntity.type].createAuthTables(auth);

export const getLoginFn = async (auth: Auth) =>
  databaseAdapters[auth.databaseEntity.type].createAuthTables(auth);

export const checkUserCredentials = async (auth: Auth, username: string, password: string) =>
  databaseAdapters[auth.databaseEntity.type].checkUserCredentials(
    auth.databaseEntity,
    auth,
    username,
    password,
  );

export const insertAuthUser = async (auth: Auth, input: InsertAuthUserInput) =>
  databaseAdapters[auth.databaseEntity.type].insertAuthUser(auth, input);

export const verifyAuthTablesExist = async (auth: Auth) => {
  try {
    await databaseAdapters[auth.databaseEntity.type].verifyAuthTablesExist(auth);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Auth user table not found at ${auth.schema}.user — set auth.autoCreateTables: true to provision it on boot, or run "graphoria seed-auth" after applying the schema manually. (driver: ${cause})`,
    );
  }
};

import type { Auth } from "../../types/configuration";
import type {
  InsertAuthUserInput,
  ListAuthUsersInput,
  ResetAuthUserPasswordInput,
  SetAuthUserActiveInput,
  UpdateAuthUserInput,
} from "../core/function-mapping";

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

export const listAuthUsers = async (auth: Auth, query: ListAuthUsersInput) =>
  databaseAdapters[auth.databaseEntity.type].listAuthUsers(auth, query);

export const getAuthUser = async (auth: Auth, username: string) =>
  databaseAdapters[auth.databaseEntity.type].getAuthUser(auth, username);

export const updateAuthUser = async (auth: Auth, input: UpdateAuthUserInput) =>
  databaseAdapters[auth.databaseEntity.type].updateAuthUser(auth, input);

export const setAuthUserActive = async (auth: Auth, input: SetAuthUserActiveInput) =>
  databaseAdapters[auth.databaseEntity.type].setAuthUserActive(auth, input);

export const deleteAuthUser = async (auth: Auth, username: string) =>
  databaseAdapters[auth.databaseEntity.type].deleteAuthUser(auth, username);

export const resetAuthUserPassword = async (auth: Auth, input: ResetAuthUserPasswordInput) =>
  databaseAdapters[auth.databaseEntity.type].resetAuthUserPassword(auth, input);

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

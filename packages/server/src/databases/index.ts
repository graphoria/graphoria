// Core database operations
export { executeQuery, executeQueryJSON, callStoredProcedure } from "./core/executor";

export { generateSQL } from "./core/query-builder";

export { databaseAdapters } from "./core/function-mapping";

// Database metadata operations
export { getDatabaseStructure, getViewsFromDB } from "./metadata/structure";

// Authentication operations
export {
  createAuthTables,
  getLoginFn,
  checkUserCredentials,
  deleteAuthUser,
  getAuthUser,
  insertAuthUser,
  listAuthUsers,
  resetAuthUserPassword,
  setAuthUserActive,
  updateAuthUser,
  verifyAuthTablesExist,
} from "./auth/auth-operations";

export type {
  ResetAuthUserPasswordInput,
  SetAuthUserActiveInput,
  UpdateAuthUserInput,
} from "./core/function-mapping";

export {
  AuthUserExistsError,
  AuthUserProtectedError,
  parseAuthUserActiveInput,
  parseAuthUserInput,
  parseAuthUserPasswordInput,
  parseAuthUserUpdateInput,
  parseAuthUsername,
  userRoles,
} from "./auth/users";

// Data transformation operations
export {
  buildRelationshipResolver,
  buildTableResolver,
  buildProcedureResolver,
} from "./transformers/data-transformers";

// High-level operations
export { getDatabasesStructure, sourcesForEachRole } from "./high-level-operations";

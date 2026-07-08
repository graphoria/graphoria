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
  insertAuthUser,
  verifyAuthTablesExist,
} from "./auth/auth-operations";

// Data transformation operations
export {
  buildRelationshipResolver,
  buildTableResolver,
  buildProcedureResolver,
} from "./transformers/data-transformers";

// High-level operations
export { getDatabasesStructure, sourcesForEachRole } from "./high-level-operations";

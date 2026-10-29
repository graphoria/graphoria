import type { OperationAnalysis, VariableDefinition } from "../../analyzeQuery/types";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { Auth, Database, DatabaseType } from "../../types/configuration";
import type { DatabaseStructure, ProcedureResolver, TableResolver, View } from "../../types/db";
import type { GenerateCreateTableSQLParameters } from "../schemaBuilder/generateCreateTable";
import type { PageLimits } from "../common";

import {
  checkUserCredentials as checkUserCredentialsMSSQL,
  createAuthTables as createAuthTablesMSSQL,
  deleteAuthUser as deleteAuthUserMSSQL,
  getAuthUser as getAuthUserMSSQL,
  insertAuthUser as insertAuthUserMSSQL,
  listAuthUsers as listAuthUsersMSSQL,
  resetAuthUserPassword as resetAuthUserPasswordMSSQL,
  setAuthUserActive as setAuthUserActiveMSSQL,
  updateAuthUser as updateAuthUserMSSQL,
  verifyAuthTablesExist as verifyAuthTablesExistMSSQL,
} from "../engines/mssql/auth";
import {
  callStoredProcedure as callStoredProcedureMSSQL,
  executeQueryJSON as executeQueryJsonMSSQL,
  executeQuery as executeQueryMSSQL,
} from "../engines/mssql/connection";
import { format as formatMSSQL } from "../engines/mssql/format";
import { getDatabaseStructure as getStructureMSSQL } from "../engines/mssql/getStructure";
import { getViewsFromDB as viewMSSQL } from "../engines/mssql/getViews";
import { generateSQL as queryMssql } from "../engines/mssql/query";
import {
  checkUserCredentials as checkUserCredentialsMySQL,
  createAuthTables as createAuthTablesMySQL,
  deleteAuthUser as deleteAuthUserMySQL,
  getAuthUser as getAuthUserMySQL,
  insertAuthUser as insertAuthUserMySQL,
  listAuthUsers as listAuthUsersMySQL,
  resetAuthUserPassword as resetAuthUserPasswordMySQL,
  setAuthUserActive as setAuthUserActiveMySQL,
  updateAuthUser as updateAuthUserMySQL,
  verifyAuthTablesExist as verifyAuthTablesExistMySQL,
} from "../engines/mysql/auth";
import {
  callStoredProcedure as callStoredProcedureMySQL,
  executeQueryJSON as executeQueryJsonMySQL,
  executeQuery as executeQueryMySQL,
} from "../engines/mysql/connection";
import { format as formatMySQL } from "../engines/mysql/format";
import { getDatabaseStructure as getStructureMySQL } from "../engines/mysql/getStructure";
import { getViewsFromDB as viewMySQL } from "../engines/mysql/getViews";
import { generateSQL as queryMySQL } from "../engines/mysql/query";
import {
  checkUserCredentials as checkUserCredentialsPostgreSQL,
  createAuthTables as createAuthTablesPostgreSQL,
  deleteAuthUser as deleteAuthUserPostgreSQL,
  getAuthUser as getAuthUserPostgreSQL,
  insertAuthUser as insertAuthUserPostgreSQL,
  listAuthUsers as listAuthUsersPostgreSQL,
  resetAuthUserPassword as resetAuthUserPasswordPostgreSQL,
  setAuthUserActive as setAuthUserActivePostgreSQL,
  updateAuthUser as updateAuthUserPostgreSQL,
  verifyAuthTablesExist as verifyAuthTablesExistPostgreSQL,
} from "../engines/postgresql/auth";
import {
  callStoredProcedure as callStoredProcedurePostgreSQL,
  executeQueryJSON as executeQueryJsonPostgreSQL,
  executeQuery as executeQueryPostgreSQL,
} from "../engines/postgresql/connection";
import { format as formatPostgreSQL } from "../engines/postgresql/format";
import { getDatabaseStructure as getStructurePostgreSQL } from "../engines/postgresql/getStructure";
import { getViewsFromDB as viewPostgreSQL } from "../engines/postgresql/getViews";
import { generateSQL as queryPostgreSQL } from "../engines/postgresql/query";
import {
  checkUserCredentials as checkUserCredentialsSQLite,
  createAuthTables as createAuthTablesSQLite,
  deleteAuthUser as deleteAuthUserSQLite,
  getAuthUser as getAuthUserSQLite,
  insertAuthUser as insertAuthUserSQLite,
  listAuthUsers as listAuthUsersSQLite,
  resetAuthUserPassword as resetAuthUserPasswordSQLite,
  setAuthUserActive as setAuthUserActiveSQLite,
  updateAuthUser as updateAuthUserSQLite,
  verifyAuthTablesExist as verifyAuthTablesExistSQLite,
} from "../engines/sqlite/auth";
import {
  callStoredProcedure as callStoredProcedureSQLite,
  executeQueryJSON as executeQueryJsonSQLite,
  executeQuery as executeQuerySQLite,
} from "../engines/sqlite/connection";
import { format as formatSQLite } from "../engines/sqlite/format";
import { getDatabaseStructure as getStructureSQLite } from "../engines/sqlite/getStructure";
import { getViewsFromDB as viewSQLite } from "../engines/sqlite/getViews";
import { generateSQL as querySQLite } from "../engines/sqlite/query";
import {
  generateCreateTableMSSQL,
  generateCreateTableMySQL,
  generateCreateTablePostgreSQL,
  generateCreateTableSQLite,
} from "../schemaBuilder/generateCreateTable";
import {
  generateInsertSQLMSSQL,
  generateInsertSQLMySQL,
  generateInsertSQLPostgreSQL,
  generateInsertSQLSQLite,
} from "../schemaBuilder/generateInsert";

export type CheckUserCredentialsResult =
  | {
      valid: false;
      role: null;
      claims: null;
    }
  | {
      valid: true;
      role: string;
      claims: Record<string, unknown>;
    };

export type InsertAuthUserInput = {
  username: string;
  password: string;
  role: string;
  claims?: Record<string, unknown>;
};

export type ListAuthUsersInput = { search: string; role: string; offset: number; limit: number };

export type UpdateAuthUserInput = {
  username: string;
  role: string;
  claims: Record<string, unknown>;
};

export type SetAuthUserActiveInput = { username: string; isActive: boolean };

export type ResetAuthUserPasswordInput = { username: string; password: string };

export type AuthUserSummary = { username: string; role: string; isActive: boolean };

export type AuthUserPage = { users: AuthUserSummary[]; total: number };

export type DatabaseFunctions = {
  query: (
    entities: MergedEntities,
    operation: OperationAnalysis,
    variables: Record<string, unknown>,
    forHashMethod: boolean,
    pageLimits: PageLimits | null,
    timeoutMs: number | undefined,
  ) => string;
  execute: <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[],
    values: Record<string, unknown>,
    timeoutMs: number | undefined,
  ) => Promise<T[]>;
  executeJson: <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[],
    values: Record<string, unknown>,
    timeoutMs: number | undefined,
  ) => Promise<T>;
  callStoredProcedure: (
    sp: ProcedureResolver,
    parameters: Record<string, unknown>,
    // oxlint-disable-next-line typescript/no-explicit-any
  ) => Promise<any>;
  getDatabaseStructure: (db: Database) => Promise<DatabaseStructure>;
  getViews: (db: Database) => Promise<View[]>;
  format: (data: string) => string;
  generateInsertSQL: (
    table: TableResolver,
    // oxlint-disable-next-line typescript/no-explicit-any
    data: Record<string, any>[],
  ) => string;
  generateCreateTableSQL: (
    table: TableResolver,
    params: GenerateCreateTableSQLParameters,
  ) => string;
  createAuthTables: (auth: Auth) => Promise<void>;
  checkUserCredentials: (
    db: Database,
    auth: Auth,
    username: string,
    password: string,
  ) => Promise<CheckUserCredentialsResult>;
  insertAuthUser: (auth: Auth, input: InsertAuthUserInput) => Promise<void>;
  listAuthUsers: (auth: Auth, query: ListAuthUsersInput) => Promise<AuthUserPage>;
  getAuthUser: (auth: Auth, username: string) => Promise<AuthUserSummary | null>;
  updateAuthUser: (auth: Auth, input: UpdateAuthUserInput) => Promise<void>;
  setAuthUserActive: (auth: Auth, input: SetAuthUserActiveInput) => Promise<void>;
  deleteAuthUser: (auth: Auth, username: string) => Promise<void>;
  resetAuthUserPassword: (auth: Auth, input: ResetAuthUserPasswordInput) => Promise<void>;
  verifyAuthTablesExist: (auth: Auth) => Promise<void>;
};

export const databaseAdapters: Record<DatabaseType, DatabaseFunctions> = {
  mssql: {
    query: queryMssql,
    callStoredProcedure: callStoredProcedureMSSQL,
    executeJson: executeQueryJsonMSSQL,
    execute: executeQueryMSSQL,
    getDatabaseStructure: getStructureMSSQL,
    getViews: viewMSSQL,
    format: formatMSSQL,
    generateInsertSQL: generateInsertSQLMSSQL,
    generateCreateTableSQL: generateCreateTableMSSQL,
    createAuthTables: createAuthTablesMSSQL,
    checkUserCredentials: checkUserCredentialsMSSQL,
    insertAuthUser: insertAuthUserMSSQL,
    listAuthUsers: listAuthUsersMSSQL,
    getAuthUser: getAuthUserMSSQL,
    updateAuthUser: updateAuthUserMSSQL,
    setAuthUserActive: setAuthUserActiveMSSQL,
    deleteAuthUser: deleteAuthUserMSSQL,
    resetAuthUserPassword: resetAuthUserPasswordMSSQL,
    verifyAuthTablesExist: verifyAuthTablesExistMSSQL,
  },
  pg: {
    query: queryPostgreSQL,
    callStoredProcedure: callStoredProcedurePostgreSQL,
    executeJson: executeQueryJsonPostgreSQL,
    execute: executeQueryPostgreSQL,
    getDatabaseStructure: getStructurePostgreSQL,
    getViews: viewPostgreSQL,
    format: formatPostgreSQL,
    generateInsertSQL: generateInsertSQLPostgreSQL,
    generateCreateTableSQL: generateCreateTablePostgreSQL,
    createAuthTables: createAuthTablesPostgreSQL,
    checkUserCredentials: checkUserCredentialsPostgreSQL,
    insertAuthUser: insertAuthUserPostgreSQL,
    listAuthUsers: listAuthUsersPostgreSQL,
    getAuthUser: getAuthUserPostgreSQL,
    updateAuthUser: updateAuthUserPostgreSQL,
    setAuthUserActive: setAuthUserActivePostgreSQL,
    deleteAuthUser: deleteAuthUserPostgreSQL,
    resetAuthUserPassword: resetAuthUserPasswordPostgreSQL,
    verifyAuthTablesExist: verifyAuthTablesExistPostgreSQL,
  },
  mysql: {
    query: queryMySQL,
    callStoredProcedure: callStoredProcedureMySQL,
    executeJson: executeQueryJsonMySQL,
    execute: executeQueryMySQL,
    getDatabaseStructure: getStructureMySQL,
    getViews: viewMySQL,
    format: formatMySQL,
    generateInsertSQL: generateInsertSQLMySQL,
    generateCreateTableSQL: generateCreateTableMySQL,
    createAuthTables: createAuthTablesMySQL,
    checkUserCredentials: checkUserCredentialsMySQL,
    insertAuthUser: insertAuthUserMySQL,
    listAuthUsers: listAuthUsersMySQL,
    getAuthUser: getAuthUserMySQL,
    updateAuthUser: updateAuthUserMySQL,
    setAuthUserActive: setAuthUserActiveMySQL,
    deleteAuthUser: deleteAuthUserMySQL,
    resetAuthUserPassword: resetAuthUserPasswordMySQL,
    verifyAuthTablesExist: verifyAuthTablesExistMySQL,
  },
  sqlite: {
    query: querySQLite,
    callStoredProcedure: callStoredProcedureSQLite,
    executeJson: executeQueryJsonSQLite,
    execute: executeQuerySQLite,
    getDatabaseStructure: getStructureSQLite,
    getViews: viewSQLite,
    format: formatSQLite,
    generateInsertSQL: generateInsertSQLSQLite,
    generateCreateTableSQL: generateCreateTableSQLite,
    createAuthTables: createAuthTablesSQLite,
    checkUserCredentials: checkUserCredentialsSQLite,
    insertAuthUser: insertAuthUserSQLite,
    listAuthUsers: listAuthUsersSQLite,
    getAuthUser: getAuthUserSQLite,
    updateAuthUser: updateAuthUserSQLite,
    setAuthUserActive: setAuthUserActiveSQLite,
    deleteAuthUser: deleteAuthUserSQLite,
    resetAuthUserPassword: resetAuthUserPasswordSQLite,
    verifyAuthTablesExist: verifyAuthTablesExistSQLite,
  },
} as const;

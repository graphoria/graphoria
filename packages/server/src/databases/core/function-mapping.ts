import type { OperationAnalysis, VariableDefinition } from "../../analyzeQuery/types";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { Auth, Database, DatabaseType } from "../../types/configuration";
import type { DatabaseStructure, ProcedureResolver, TableResolver, View } from "../../types/db";
import type { GenerateCreateTableSQLParameters } from "../schemaBuilder/generateCreateTable";

import {
  checkUserCredentials as checkUserCredentialsMSSQL,
  createAuthTables as createAuthTablesMSSQL,
  insertAuthUser as insertAuthUserMSSQL,
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
  insertAuthUser as insertAuthUserMySQL,
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
  insertAuthUser as insertAuthUserPostgreSQL,
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
  generateCreateTableMSSQL,
  generateCreateTableMySQL,
  generateCreateTablePostgreSQL,
} from "../schemaBuilder/generateCreateTable";
import {
  generateInsertSQLMSSQL,
  generateInsertSQLMySQL,
  generateInsertSQLPostgreSQL,
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

type DatabaseFunctions = {
  query: (
    entities: MergedEntities,
    operation: OperationAnalysis,
    variables: Record<string, unknown>,
    forHashMethod: boolean,
  ) => string;
  execute: <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[],
    values: Record<string, unknown>,
  ) => Promise<T[]>;
  executeJson: <T>(
    query: string,
    db: Database,
    variablesDefinition: VariableDefinition[],
    values: Record<string, unknown>,
  ) => Promise<T>;
  callStoredProcedure: (
    sp: ProcedureResolver,
    variablesDefinition: VariableDefinition[],
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
    verifyAuthTablesExist: verifyAuthTablesExistMySQL,
  },
} as const;

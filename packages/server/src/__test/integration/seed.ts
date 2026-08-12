import { SQL } from "bun";
import { ConnectionPool } from "mssql";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DatabaseType } from "../../types/configuration";

import { CONNECTIONS } from "./config";

/**
 * Applies the canonical schema and its seed rows to a real engine.
 *
 * Statements in the `.sql` files are separated by a line containing exactly
 * `;;`, because stored-procedure bodies contain semicolons and a naive split on
 * `;` would cut them in half.
 */

const SEPARATOR = /\r?\n;;\r?\n?/;

const statementsFor = async (engine: DatabaseType) => {
  const path = join(import.meta.dir, "schema", `${engine}.sql`);
  const sql = await readFile(path, "utf8");

  return sql
    .split(SEPARATOR)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !statement.split("\n").every(isCommentLine));
};

const isCommentLine = (line: string) => {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("--");
};

/**
 * Row counts the seed data produces. The smoke test asserts these, so a schema
 * file that silently stops applying halfway through fails loudly.
 */
export const EXPECTED_COUNTS = {
  organizations: 2,
  users: 6,
  projects: 3,
  tasks: 10,
  tags: 5,
  task_tags: 8,
  activity_log: 3,
  type_showcase: 2,
} as const;

const seedPostgres = async () => {
  const sql = new SQL({ ...CONNECTIONS.pg, max: 1 });

  try {
    for (const statement of await statementsFor("pg")) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.close();
  }
};

const seedMySQL = async () => {
  // Connect to the server-created database: the schema file drops and recreates
  // the two databases the suite actually uses, so it cannot connect to one of
  // them while doing so.
  const sql = new SQL({
    hostname: CONNECTIONS.mysql.host,
    port: CONNECTIONS.mysql.port,
    username: CONNECTIONS.mysql.user,
    password: CONNECTIONS.mysql.password,
    database: "graphoria_test",
    adapter: "mysql",
    max: 1,
  });

  try {
    for (const statement of await statementsFor("mysql")) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.close();
  }
};

const mssqlPool = (database: string) =>
  new ConnectionPool({
    server: CONNECTIONS.mssql.host,
    port: CONNECTIONS.mssql.port,
    user: CONNECTIONS.mssql.user,
    password: CONNECTIONS.mssql.password,
    database,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
  });

const seedMSSQL = async () => {
  // The SQL Server image cannot pre-create a database, so do it from master.
  const master = await mssqlPool("master").connect();
  try {
    await master
      .request()
      .batch(
        `IF DB_ID('${CONNECTIONS.mssql.database}') IS NULL CREATE DATABASE [${CONNECTIONS.mssql.database}]`,
      );
  } finally {
    await master.close();
  }

  const pool = await mssqlPool(CONNECTIONS.mssql.database).connect();
  try {
    for (const statement of await statementsFor("mssql")) {
      await pool.request().batch(statement);
    }
  } finally {
    await pool.close();
  }
};

const SEEDERS: Record<DatabaseType, () => Promise<void>> = {
  pg: seedPostgres,
  mysql: seedMySQL,
  mssql: seedMSSQL,
};

/** Drops and recreates the canonical schema on `engine`, then seeds it. */
export const seedEngine = async (engine: DatabaseType) => SEEDERS[engine]();

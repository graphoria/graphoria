import { SQL } from "bun";
import { ConnectionPool } from "mssql";

import type { DatabaseType } from "../src/types/configuration";

import { CONNECTIONS, MYSQL_CONNECTION_OPTIONS } from "../src/__test/integration/config";
import { BENCH_DATABASE, BENCH_SCHEMAS, ROW_COUNTS, benchTable } from "./config";

/**
 * Builds the benchmark dataset: 1k users, 10k projects and 100k tasks in a
 * `graphoria_bench` database on the same container as the integration suite.
 *
 * Every value is derived arithmetically from the row id rather than randomly,
 * so two runs on two machines benchmark byte-identical data — which is what
 * makes the committed numbers comparable.
 *
 * Indexes go on after the load. PostgreSQL and SQL Server do not index a
 * foreign key for you, and the N+1 audit found the nested query's plan shape
 * depends on those indexes existing.
 */

/** SQL Server caps a `VALUES` list at 1000 rows; the other two are happy with it. */
const CHUNK = 1000;

const bool = (engine: DatabaseType, value: boolean) =>
  engine === "mssql" ? (value ? "1" : "0") : String(value);

/** A fixed instant, so `created_at` and `due_at` never depend on when the seed ran. */
const EPOCH = Date.UTC(2024, 0, 1);
const timestamp = (dayOffset: number) =>
  new Date(EPOCH + dayOffset * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

const userRows = (engine: DatabaseType) =>
  Array.from({ length: ROW_COUNTS.users }, (_, index) => {
    const id = index + 1;
    return `(${id}, 'user${id}@bench.local', 'User ${id}', ${bool(engine, id % 10 !== 0)}, '${timestamp(id % 365)}')`;
  });

const projectRows = (engine: DatabaseType) =>
  Array.from({ length: ROW_COUNTS.projects }, (_, index) => {
    const id = index + 1;
    const ownerId = (id % ROW_COUNTS.users) + 1;
    const budget = (id % 5000) + 0.5;
    return `(${id}, ${ownerId}, 'Project ${id}', ${budget}, ${bool(engine, id % 20 === 0)})`;
  });

const taskRows = (engine: DatabaseType) =>
  Array.from({ length: ROW_COUNTS.tasks }, (_, index) => {
    const id = index + 1;
    // 7919 is coprime with 10000, so each project gets exactly ten tasks while
    // the ids are scattered rather than contiguous — a clustered layout would
    // flatter the index more than a real workload does.
    const projectId = ((id * 7919) % ROW_COUNTS.projects) + 1;
    const userId = id % 17 === 0 ? "NULL" : `${((id * 104_729) % ROW_COUNTS.users) + 1}`;
    const dueAt = id % 7 === 0 ? "NULL" : `'${timestamp(id % 365)}'`;
    return `(${id}, ${projectId}, ${userId}, 'Task ${id}', ${(id % 5) + 1}, ${((id % 40) + 1) / 2}, ${bool(engine, id % 3 === 0)}, ${dueAt})`;
  });

type Client = {
  run: (statement: string) => Promise<unknown>;
  close: () => Promise<unknown>;
};

const tableDefinitions = (engine: DatabaseType) => {
  const schema = BENCH_SCHEMAS[engine];
  const boolType = engine === "mssql" ? "bit" : "boolean";
  const timestampType = engine === "mssql" ? "datetime2" : "timestamp";

  return [
    `CREATE TABLE ${schema}.users (
       id integer PRIMARY KEY,
       email varchar(200) NOT NULL,
       display_name varchar(200) NOT NULL,
       is_active ${boolType} NOT NULL,
       created_at ${timestampType} NOT NULL
     )`,
    // Table-level constraints, not inline `REFERENCES`: MySQL parses an inline
    // column reference and then silently discards it, so the relationship would
    // never reach introspection and the nested scenario would have no field.
    `CREATE TABLE ${schema}.projects (
       id integer PRIMARY KEY,
       owner_id integer NOT NULL,
       name varchar(200) NOT NULL,
       budget decimal(12, 2) NULL,
       archived ${boolType} NOT NULL,
       CONSTRAINT fk_bench_projects_owner FOREIGN KEY (owner_id) REFERENCES ${schema}.users (id)
     )`,
    `CREATE TABLE ${schema}.tasks (
       id integer PRIMARY KEY,
       project_id integer NOT NULL,
       user_id integer NULL,
       title varchar(200) NOT NULL,
       priority integer NOT NULL,
       estimate_hours decimal(6, 2) NULL,
       completed ${boolType} NOT NULL,
       due_at ${timestampType} NULL,
       CONSTRAINT fk_bench_tasks_project FOREIGN KEY (project_id) REFERENCES ${schema}.projects (id),
       CONSTRAINT fk_bench_tasks_user FOREIGN KEY (user_id) REFERENCES ${schema}.users (id)
     )`,
  ];
};

const indexDefinitions = (engine: DatabaseType) => {
  const schema = BENCH_SCHEMAS[engine];

  return [
    `CREATE INDEX ix_bench_projects_owner ON ${schema}.projects (owner_id)`,
    `CREATE INDEX ix_bench_tasks_project ON ${schema}.tasks (project_id)`,
    `CREATE INDEX ix_bench_tasks_user ON ${schema}.tasks (user_id)`,
    `CREATE INDEX ix_bench_tasks_priority ON ${schema}.tasks (priority, completed)`,
  ];
};

/**
 * A bulk-loaded table has no statistics, so the planner guesses — and then
 * autoanalyze arrives partway through a benchmark and silently changes the plan
 * mid-run. Updating them here is what makes two runs comparable.
 */
const analyzeStatements = (engine: DatabaseType) => {
  const tables = ["users", "projects", "tasks"].map((table) => benchTable(engine, table));

  if (engine === "mysql") return [`ANALYZE TABLE ${tables.join(", ")}`];
  if (engine === "pg") return tables.map((table) => `ANALYZE ${table}`);
  return tables.map((table) => `UPDATE STATISTICS ${table}`);
};

/** Returns the 100 highest-priority tasks. The closest thing Graphoria has to a
 *  write path: it generates no insert/update/delete resolvers, so a stored
 *  routine is what a `Mutation` field actually calls. */
const routineDefinition = (engine: DatabaseType) => {
  const schema = BENCH_SCHEMAS[engine];

  if (engine === "pg") {
    return `CREATE FUNCTION ${schema}.tasks_by_priority(min_priority integer)
            RETURNS TABLE (id integer, title varchar, priority integer)
            AS $$
              SELECT t.id, t.title, t.priority
              FROM ${schema}.tasks t
              WHERE t.priority >= min_priority
              ORDER BY t.id
              LIMIT 100;
            $$ LANGUAGE sql`;
  }

  if (engine === "mysql") {
    return `CREATE PROCEDURE ${schema}.tasks_by_priority(IN min_priority int)
            BEGIN
              SELECT t.id, t.title, t.priority
              FROM ${schema}.tasks t
              WHERE t.priority >= min_priority
              ORDER BY t.id
              LIMIT 100;
            END`;
  }

  return `CREATE PROCEDURE ${schema}.tasks_by_priority @min_priority int
          AS
          BEGIN
            SET NOCOUNT ON;
            SELECT TOP 100 t.id, t.title, t.priority
            FROM ${schema}.tasks t
            WHERE t.priority >= @min_priority
            ORDER BY t.id;
          END`;
};

const bunClient = (engine: "pg" | "mysql", database: string): Client => {
  const client = new SQL({
    hostname: CONNECTIONS[engine].host,
    port: CONNECTIONS[engine].port,
    username: CONNECTIONS[engine].user,
    password: CONNECTIONS[engine].password,
    database,
    ...(engine === "mysql" ? { adapter: "mysql" as const, ...MYSQL_CONNECTION_OPTIONS } : {}),
    max: 1,
  });

  return { run: (statement) => client.unsafe(statement), close: () => client.close() };
};

const mssqlClient = async (database: string): Promise<Client> => {
  const pool = await new ConnectionPool({
    server: CONNECTIONS.mssql.host,
    port: CONNECTIONS.mssql.port,
    user: CONNECTIONS.mssql.user,
    password: CONNECTIONS.mssql.password,
    database,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
    requestTimeout: 120_000,
  }).connect();

  return { run: (statement) => pool.request().batch(statement), close: () => pool.close() };
};

/**
 * Drops whatever a previous run left behind and recreates the empty schema.
 * Returns a client already pointed at the bench database.
 */
const resetSchema = async (engine: DatabaseType): Promise<Client> => {
  if (engine === "mysql") {
    const admin = bunClient("mysql", CONNECTIONS.mysql.database);
    try {
      await admin.run(`DROP DATABASE IF EXISTS ${BENCH_DATABASE}`);
      await admin.run(`CREATE DATABASE ${BENCH_DATABASE}`);
    } finally {
      await admin.close();
    }
    return bunClient("mysql", BENCH_DATABASE);
  }

  if (engine === "pg") {
    const admin = bunClient("pg", CONNECTIONS.pg.database);
    try {
      const existing = await admin.run(
        `SELECT 1 FROM pg_database WHERE datname = '${BENCH_DATABASE}'`,
      );
      if ((existing as unknown[]).length === 0) {
        await admin.run(`CREATE DATABASE ${BENCH_DATABASE}`);
      }
    } finally {
      await admin.close();
    }

    const client = bunClient("pg", BENCH_DATABASE);
    await client.run(`DROP SCHEMA IF EXISTS ${BENCH_SCHEMAS.pg} CASCADE`);
    await client.run(`CREATE SCHEMA ${BENCH_SCHEMAS.pg}`);
    return client;
  }

  const master = await mssqlClient("master");
  try {
    await master.run(`IF DB_ID('${BENCH_DATABASE}') IS NULL CREATE DATABASE [${BENCH_DATABASE}]`);
  } finally {
    await master.close();
  }

  const client = await mssqlClient(BENCH_DATABASE);
  const schema = BENCH_SCHEMAS.mssql;
  await client.run(`DROP PROCEDURE IF EXISTS ${schema}.tasks_by_priority`);
  await client.run(`DROP TABLE IF EXISTS ${schema}.tasks`);
  await client.run(`DROP TABLE IF EXISTS ${schema}.projects`);
  await client.run(`DROP TABLE IF EXISTS ${schema}.users`);
  await client.run(`DROP SCHEMA IF EXISTS ${schema}`);
  // CREATE SCHEMA has to be the first statement in its batch on SQL Server.
  await client.run(`CREATE SCHEMA ${schema}`);
  return client;
};

const insertAll = async (client: Client, table: string, columns: string, rows: string[]) => {
  for (let index = 0; index < rows.length; index += CHUNK) {
    await client.run(
      `INSERT INTO ${table} (${columns}) VALUES ${rows.slice(index, index + CHUNK).join(", ")}`,
    );
  }
};

export const seedBench = async (engine: DatabaseType, log = console.log) => {
  const started = Bun.nanoseconds();
  const client = await resetSchema(engine);

  try {
    for (const statement of tableDefinitions(engine)) await client.run(statement);

    log(`  seeding ${ROW_COUNTS.users} users…`);
    await insertAll(
      client,
      benchTable(engine, "users"),
      "id, email, display_name, is_active, created_at",
      userRows(engine),
    );

    log(`  seeding ${ROW_COUNTS.projects} projects…`);
    await insertAll(
      client,
      benchTable(engine, "projects"),
      "id, owner_id, name, budget, archived",
      projectRows(engine),
    );

    log(`  seeding ${ROW_COUNTS.tasks} tasks…`);
    await insertAll(
      client,
      benchTable(engine, "tasks"),
      "id, project_id, user_id, title, priority, estimate_hours, completed, due_at",
      taskRows(engine),
    );

    log("  building indexes…");
    for (const statement of indexDefinitions(engine)) await client.run(statement);
    await client.run(routineDefinition(engine));

    log("  updating statistics…");
    for (const statement of analyzeStatements(engine)) await client.run(statement);
  } finally {
    await client.close();
  }

  log(`  done in ${((Bun.nanoseconds() - started) / 1e9).toFixed(1)}s`);
};

if (import.meta.main) {
  const engine = (Bun.argv[2] ?? "pg") as DatabaseType;
  console.log(`seeding ${engine}…`);
  await seedBench(engine);
}

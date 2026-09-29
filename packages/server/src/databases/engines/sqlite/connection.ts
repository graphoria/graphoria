import { Database as SQLiteDatabase } from "bun:sqlite";

import type { SQLiteConnection } from "../../../config";
import type { VariableDefinition } from "../../../analyzeQuery/types";
import type { Database } from "../../../types/configuration";

import { logger } from "../../../logging";
import { databasesConnections } from "../../../singletons/databases";
import { getQueryTimeoutMs } from "../../../singletons/queryTimeout";
import { assertSafeIdentifier } from "../../core/identifier";

// json_group_array(... ORDER BY ...), which every ordered list compiles to, and
// concat() arrived in 3.44.
const MIN_VERSION = [3, 44, 0] as const;

export const isSupportedVersion = (version: string) => {
  const parts = version.split(".").map(Number);

  for (const [index, minimum] of MIN_VERSION.entries()) {
    const part = parts[index] ?? 0;
    if (part !== minimum) return part > minimum;
  }

  return true;
};

// A second connection holding the write lock (another worker, the integration
// suite, an operator's shell) makes a statement wait rather than fail with
// SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000;

export const schemasOf = (db: Database) => [
  "main",
  ...Object.keys((db.connection as SQLiteConnection).attach ?? {}),
];

export const openDatabase = (db: Database): SQLiteDatabase => {
  const { filename, attach = {} } = db.connection as SQLiteConnection;
  const connection = new SQLiteDatabase(filename, { create: true });

  try {
    const { version } = connection.query("SELECT sqlite_version() AS version").get() as {
      version: string;
    };

    if (!isSupportedVersion(version)) {
      throw new Error(
        `SQLite ${MIN_VERSION.join(".")} or newer is required, and database "${db.name}" opened ${version}. ` +
          "Bun uses the system SQLite on macOS: point Database.setCustomSQLite() at a newer libsqlite3 before Graphoria starts.",
      );
    }

    connection.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Through query(): bun-types declares Database.run's bindings as arrays only,
    // though it binds a record by name at runtime.
    for (const [schema, file] of Object.entries(attach)) {
      connection
        .query(`ATTACH DATABASE $file AS "${assertSafeIdentifier(schema, "schema")}"`)
        .run({ $file: file });
    }

    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
};

/**
 * The connection every request on this worker shares: SQLite has no pool. Nor
 * can a statement be stopped from JavaScript: bun:sqlite runs it on the event
 * loop, and the process does nothing else until it returns.
 */
export const getPool = async (db: Database) => {
  const connection = openDatabase(db);
  const queryTimeoutMs = getQueryTimeoutMs();

  if (queryTimeoutMs > 0) {
    logger("db").warn(
      { database: db.name, queryTimeoutMs },
      "QUERY_TIMEOUT_MS and operation timeouts do not apply to SQLite, which cannot stop a running statement",
    );
  }

  return connection;
};

type Binding = string | bigint | number | boolean | null;

// bun:sqlite binds `$n` by name, so the builders' placeholders bind in any order
// and any number of times with no rewrite (unlike MySQL). It throws on an array
// or object value; the analyzer already spreads an array into one value each.
export const bindings = (
  variablesDefinition: VariableDefinition[],
  values: Record<string, unknown>,
) =>
  Object.fromEntries(
    variablesDefinition.map((definition, index) => [`$${index + 1}`, values[definition.name]]),
  ) as Record<string, Binding>;

// prepare(), not query(): query() caches every statement text for the life of
// the connection, and generated statements rarely repeat.
export const executeQuery = async <T>(
  query: string,
  db: Database,
  variablesDefinition: VariableDefinition[] = [],
  values: Record<string, unknown> = {},
) => {
  const statement = (databasesConnections[db.name] as SQLiteDatabase).prepare(query);

  try {
    return statement.all(bindings(variablesDefinition, values)) as T[];
  } finally {
    statement.finalize();
  }
};

// json_object() hands back text here, where PostgreSQL and MySQL return parsed JSON.
export const executeQueryJSON = async <T>(
  query: string,
  db: Database,
  variablesDefinition: VariableDefinition[] = [],
  values: Record<string, unknown> = {},
) => {
  const [row] = await executeQuery<{ json_result: string }>(query, db, variablesDefinition, values);

  return JSON.parse(row!.json_result) as T;
};

// Introspection reports no procedure on SQLite, so nothing routes a call here.
export const callStoredProcedure = async (): Promise<never> => {
  throw new Error("SQLite has no stored procedures");
};

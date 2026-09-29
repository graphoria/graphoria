import { groupBy } from "es-toolkit";

import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { Database } from "../../../types/configuration";

import { logger } from "../../../logging";
import { databasesConnections } from "../../../singletons/databases";
import { DatabaseStructureZod } from "../../../types/zod/db";
import { openDatabase, schemasOf } from "./connection";

type ObjectRow = { type: "table" | "view" | "virtual"; name: string; wr: number; strict: number };
type ColumnRow = { name: string; type: string; notnull: number; pk: number };
type ForeignKeyRow = { id: number; seq: number; table: string; from: string; to: string | null };

// SQLite keeps a declared type as written (`decimal(12, 2)`, `VARCHAR(100)`),
// where the other engines report the bare name categorizeSqlType matches.
const normalizeDeclaredType = (declared: string) =>
  declared
    .replace(/\(.*\)\s*$/, "")
    .trim()
    .toLowerCase();

// pragma_table_list rather than sqlite_schema, which also lists the shadow
// tables a virtual table (FTS5, R*Tree) keeps its own data in.
const objectsOf = (connection: SQLiteDatabase, schema: string) =>
  connection
    .query(
      `SELECT type, name, wr, strict FROM pragma_table_list WHERE schema = $schema AND type IN ('table', 'view', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    )
    .all({ $schema: schema }) as ObjectRow[];

// table_xinfo rather than table_info, which leaves out generated columns. The
// hidden columns of a virtual table (hidden = 1) stay out.
const columnsOf = (connection: SQLiteDatabase, schema: string, table: string) =>
  connection
    .query(
      `SELECT name, type, "notnull", pk FROM pragma_table_xinfo($table, $schema) WHERE hidden <> 1 ORDER BY cid`,
    )
    .all({ $table: table, $schema: schema }) as ColumnRow[];

// SQLite stores NULL in a primary-key column unless the column is an INTEGER
// PRIMARY KEY, which is the rowid, or its table is WITHOUT ROWID or STRICT.
const keyRefusesNull = (object: ObjectRow, columns: ColumnRow[], column: ColumnRow) =>
  object.wr === 1 ||
  object.strict === 1 ||
  (column.type.toUpperCase() === "INTEGER" && columns.filter((c) => c.pk > 0).length === 1);

// A foreign key that names only its parent table points at the parent's primary
// key, and pragma_foreign_key_list reports its target column as NULL. SQLite
// accepts such a key on a parent with no primary key, where it leads nowhere.
const foreignKeysOf = (
  connection: SQLiteDatabase,
  database: string,
  schema: string,
  table: string,
) => {
  const rows = connection
    .query(
      `SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list($table, $schema) ORDER BY id, seq`,
    )
    .all({ $table: table, $schema: schema }) as ForeignKeyRow[];

  return Object.values(groupBy(rows, (row) => row.id)).flatMap((constraint) => {
    const parent = constraint[0]!.table;
    const parentKey = constraint.some((row) => row.to === null)
      ? columnsOf(connection, schema, parent)
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name)
      : [];
    const columns = constraint.map((row) => ({
      source: row.from,
      target: row.to ?? parentKey[row.seq],
    }));

    if (columns.some((column) => column.target === undefined)) {
      logger("db").warn(
        {
          database,
          foreignKey: `${schema}.${table}(${columns.map((column) => column.source).join(", ")})`,
          parent,
        },
        "foreign key names its parent without a column, and the parent has no primary key: no relationship served for it",
      );
      return [];
    }

    // A SQLite foreign key cannot reach into another attached file.
    return [{ schema, name: parent, columns }];
  });
};

const readStructure = (connection: SQLiteDatabase, db: Database) => {
  const tables = schemasOf(db).flatMap((schema) =>
    objectsOf(connection, schema).map((object) => {
      const columns = columnsOf(connection, schema, object.name);

      return {
        schema,
        name: object.name,
        entityType: object.type === "view" ? "view" : "table",
        tableDescription: null,
        columns: columns.map((column) => ({
          name: column.name,
          dataType: normalizeDeclaredType(column.type),
          isNullable:
            column.notnull === 0 && !(column.pk > 0 && keyRefusesNull(object, columns, column)),
          description: null,
        })),
        foreignKeys:
          object.type === "view" ? [] : foreignKeysOf(connection, db.name, schema, object.name),
      };
    }),
  );

  return DatabaseStructureZod.parse({ tables, storedProcedures: [] });
};

// The live connection when the server has one, so a `:memory:` database sees
// what `onConnect` created there. A connection of its own is only for callers
// with no server connection: the schemaBuilder/convert.ts dev script and tests.
export const getDatabaseStructure = async (db: Database) => {
  const existing = databasesConnections[db.name] as SQLiteDatabase | undefined;
  const connection = existing ?? openDatabase(db);

  try {
    return readStructure(connection, db);
  } finally {
    if (!existing) connection.close();
  }
};

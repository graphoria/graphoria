import { describe, expect, it } from "bun:test";

import type { Database, DatabaseType } from "../../types/configuration";

import { CONNECTIONS, ENGINES, MYSQL_CONNECTION_OPTIONS, SCHEMAS } from "./config";
import { integrationEnabled } from "./harness";
import { seedEngine } from "./seed";

/**
 * Guards the wide-table introspection path. MySQL assembled the per-table
 * column JSON with GROUP_CONCAT, which truncates at group_concat_max_len
 * (1024 bytes by default) — `catalog.type_showcase` produces 1565 bytes, so
 * the JSON came back cut mid-object and the whole boot failed. JSON_ARRAYAGG
 * replaced it, and since that carries no ORDER BY the declared order is
 * restored in TypeScript, so both the presence and the order of the columns
 * are asserted here.
 */

const TYPE_SHOWCASE_COLUMNS = [
  "id",
  "small_int",
  "big_int",
  "decimal_val",
  "float_val",
  "char_val",
  "varchar_val",
  "text_val",
  "bool_val",
  "date_val",
  "ts_val",
  "tstz_val",
  "json_val",
  "uuid_val",
  "bytes_val",
];

// getDatabaseStructure opens its own single-use pool from `connection` and
// touches nothing else on the database config, so the rest of the shape is
// deliberately absent rather than faked.
const introspectionDb = (engine: DatabaseType) =>
  ({
    name: "default",
    type: engine,
    connection: CONNECTIONS[engine],
    ...(engine === "mysql" ? { connectionOptions: MYSQL_CONNECTION_OPTIONS } : {}),
  }) as unknown as Database;

describe.skipIf(!integrationEnabled)("integration introspection", () => {
  for (const engine of ENGINES) {
    it(`${engine}: reports every column of a wide table, in declared order`, async () => {
      const { databaseAdapters } = await import("../../databases/core/function-mapping");

      await seedEngine(engine);

      const structure = await databaseAdapters[engine].getDatabaseStructure(
        introspectionDb(engine),
      );

      const table = structure.tables.find(
        (candidate) =>
          candidate.schema === SCHEMAS[engine].catalog && candidate.name === "type_showcase",
      );

      expect(table).toBeDefined();
      expect(table?.columns.map((column) => column.name)).toEqual(TYPE_SHOWCASE_COLUMNS);
    });

    it(`${engine}: reports foreign keys of a table that has several`, async () => {
      const { databaseAdapters } = await import("../../databases/core/function-mapping");

      const structure = await databaseAdapters[engine].getDatabaseStructure(
        introspectionDb(engine),
      );

      const table = structure.tables.find(
        (candidate) => candidate.schema === SCHEMAS[engine].app && candidate.name === "tasks",
      );

      expect(table?.foreignKeys.map((fk) => fk.name).sort()).toEqual([
        "organizations",
        "projects",
        "users",
      ]);
      expect(table?.foreignKeys.every((fk) => fk.columns.length === 1)).toBe(true);
    });
  }
});

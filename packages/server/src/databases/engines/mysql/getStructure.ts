import type { Database } from "../../../types/configuration";

import { DatabaseStructureZod } from "../../../types/zod/db";
import { executeQueryJSONSingle } from "./connection";

/**
 * Ordering carried out of SQL and restored here: JSON_ARRAYAGG accepts no
 * ORDER BY. GROUP_CONCAT does, but silently truncates at group_concat_max_len
 * (1024 bytes by default), which any table past ~10 columns exceeds — the JSON
 * is then cut mid-object and CAST(... AS JSON) fails.
 */
type Ordered = { ordinalPosition?: number };
type RawForeignKey = { fkName?: string; columns: Ordered[] };
type RawStructure = {
  tables?: { columns?: Ordered[]; foreignKeys?: RawForeignKey[] }[];
  storedProcedures?: { parameters?: Ordered[] }[];
};

const byOrdinal = (a: Ordered, b: Ordered) => (a.ordinalPosition ?? 0) - (b.ordinalPosition ?? 0);

export const getDatabaseStructure = async (db: Database) => {
  const res = await executeQueryJSONSingle<RawStructure>(
    `
    SELECT JSON_OBJECT(
      'tables', JSON_ARRAYAGG(
        JSON_OBJECT(
          'schema', t.table_schema,
          'name', t.table_name,
          'entityType', CASE WHEN t.table_type = 'BASE TABLE' THEN 'table' ELSE 'view' END,
          'columns', COALESCE(col.columns, JSON_ARRAY()),
          'foreignKeys', COALESCE(fk.fk_agg, JSON_ARRAY())
        )
      ),
      'storedProcedures', COALESCE(
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'schema', r.routine_schema,
              'name', r.routine_name,
              'type', CASE r.routine_type
                        WHEN 'FUNCTION' THEN 'function'
                        WHEN 'PROCEDURE' THEN 'procedure'
                        ELSE 'unknown'
                      END,
              'parameters', COALESCE(params.param_array, JSON_ARRAY())
            )
          )
          FROM information_schema.routines r

          -- Parameters
          LEFT JOIN LATERAL (
            SELECT JSON_ARRAYAGG(
              JSON_OBJECT(
                'name', p.parameter_name,
                'dataType', p.data_type,
                'maxLength', COALESCE(p.character_maximum_length, 0),
                'precision', COALESCE(p.numeric_precision, 0),
                'scale', COALESCE(p.numeric_scale, 0),
                'ordinalPosition', p.ordinal_position
              )
            ) AS param_array
            FROM information_schema.parameters p
            WHERE p.specific_name = r.specific_name
              AND p.specific_schema = r.routine_schema
              AND p.parameter_name IS NOT NULL
          ) params ON true

          WHERE r.routine_type IN ('FUNCTION', 'PROCEDURE')
          AND r.routine_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
        ),
        JSON_ARRAY()
      )
    ) as json_result
    FROM (
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_type IN ('BASE TABLE', 'VIEW')
        AND table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
    ) t
    LEFT JOIN LATERAL (
      SELECT JSON_ARRAYAGG(
        JSON_OBJECT(
          'name', isc.column_name,
          'dataType', isc.data_type,
          'isNullable', CASE WHEN isc.is_nullable = 'YES' THEN true ELSE false END,
          'collation', isc.collation_name,
          'description', NULL,
          'ordinalPosition', isc.ordinal_position
        )
      ) AS columns
      FROM information_schema.columns isc
      WHERE isc.table_schema = t.table_schema
        AND isc.table_name = t.table_name
    ) col ON TRUE
    LEFT JOIN LATERAL (
      -- aggregate FKs: first aggregate columns per constraint, then aggregate constraints
      SELECT JSON_ARRAYAGG(
        JSON_OBJECT(
          'schema', fk_sub.referenced_table_schema,
          'name', fk_sub.referenced_table_name,
          'columns', fk_sub.columns_arr,
          'fkName', fk_sub.fk_name
        )
      ) AS fk_agg
      FROM (
        SELECT
          kcu.constraint_name AS fk_name,
          kcu.table_schema,
          kcu.table_name,
          kcu.referenced_table_schema,
          kcu.referenced_table_name,
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'source', kcu.column_name,
              'target', kcu.referenced_column_name,
              'ordinalPosition', kcu.ordinal_position
            )
          ) AS columns_arr
        FROM information_schema.key_column_usage kcu
        WHERE kcu.referenced_table_schema IS NOT NULL
          AND kcu.table_schema = t.table_schema
          AND kcu.table_name = t.table_name
        GROUP BY kcu.constraint_name, kcu.table_schema, kcu.table_name,
                kcu.referenced_table_schema, kcu.referenced_table_name
      ) fk_sub
    ) fk ON TRUE;
    `,
    db,
  );

  for (const table of res.tables ?? []) {
    table.columns?.sort(byOrdinal);
    table.foreignKeys?.sort((a, b) => (a.fkName ?? "").localeCompare(b.fkName ?? ""));

    // TableRelationshipZod is strict, so the ordering keys must go before parsing.
    for (const foreignKey of table.foreignKeys ?? []) {
      foreignKey.columns.sort(byOrdinal);
      for (const column of foreignKey.columns) delete column.ordinalPosition;
      delete foreignKey.fkName;
    }
  }

  for (const storedProcedure of res.storedProcedures ?? []) {
    storedProcedure.parameters?.sort(byOrdinal);
  }

  return DatabaseStructureZod.parse(res);
};

import type { Database } from "../../../types/configuration";

import { DatabaseStructureZod } from "../../../types/zod/db";
import { executeQueryJSONSingle } from "./connection";

export const getDatabaseStructure = async (db: Database) => {
  const res = await executeQueryJSONSingle(
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
                'scale', COALESCE(p.numeric_scale, 0)
              )
            ) AS param_array
            FROM information_schema.parameters p
            WHERE p.specific_name = r.specific_name
              AND p.specific_schema = r.routine_schema
              AND p.parameter_name IS NOT NULL
            ORDER BY p.ordinal_position
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
      -- build an ordered JSON array of columns using GROUP_CONCAT
      SELECT IFNULL(
        CAST(CONCAT('[', GROUP_CONCAT(
          JSON_OBJECT(
            'name', isc.column_name,
            'dataType', isc.data_type,
            'isNullable', CASE WHEN isc.is_nullable = 'YES' THEN true ELSE false END,
            'description', NULL
          ) ORDER BY isc.ordinal_position SEPARATOR ','), ']') AS JSON),
        JSON_ARRAY()
      ) AS columns
      FROM information_schema.columns isc
      WHERE isc.table_schema = t.table_schema
        AND isc.table_name = t.table_name
    ) col ON TRUE
    LEFT JOIN LATERAL (
      -- aggregate FKs: first aggregate columns per constraint, then aggregate constraints
      SELECT IFNULL(
        CAST(CONCAT('[', GROUP_CONCAT(
          JSON_OBJECT(
            'schema', fk_sub.referenced_table_schema,
            'name', fk_sub.referenced_table_name,
            'columns', fk_sub.columns_arr
          ) ORDER BY fk_sub.fk_name SEPARATOR ','), ']') AS JSON),
        JSON_ARRAY()
      ) AS fk_agg
      FROM (
        SELECT 
          kcu.constraint_name AS fk_name,
          kcu.table_schema,
          kcu.table_name,
          kcu.referenced_table_schema,
          kcu.referenced_table_name,
          CAST(CONCAT('[', GROUP_CONCAT(
            JSON_OBJECT('source', kcu.column_name, 'target', kcu.referenced_column_name)
            ORDER BY kcu.ordinal_position SEPARATOR ','
          ), ']') AS JSON) AS columns_arr
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

  return DatabaseStructureZod.parse(res);
};

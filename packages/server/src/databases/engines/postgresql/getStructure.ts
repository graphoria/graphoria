import type { Database } from "../../../types/configuration";

import { DatabaseStructureZod } from "../../../types/zod/db";
import { executeQueryJSONSingle } from "./connection";

export const getDatabaseStructure = async (db: Database) => {
  const res = await executeQueryJSONSingle(
    `
    WITH tables_data AS (
      SELECT json_agg(
        json_build_object(
          'schema', t.table_schema,
          'name', t.table_name,
          'entityType', CASE WHEN t.table_type = 'BASE TABLE' THEN 'table' ELSE 'view' END,
          'tableDescription', t.table_description,
          'columns', COALESCE(col.columns, '[]'::json),
          'foreignKeys', COALESCE(fk.fk_agg, '[]'::json)
        )
      ) AS tables
      FROM (
        SELECT DISTINCT 
          ist.table_schema, 
          ist.table_name, 
          ist.table_type,
          obj_description(c.oid) AS table_description
        FROM information_schema.tables ist
        LEFT JOIN pg_class c ON c.relname = ist.table_name
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = ist.table_schema
        WHERE ist.table_type IN ('BASE TABLE', 'VIEW')
          AND ist.table_schema NOT IN ('pg_catalog', 'information_schema')
      ) t
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'name', isc.column_name,
            'dataType', isc.data_type,
            'isNullable', isc.is_nullable = 'YES',
            'description', col_desc.description
          )
        ) AS columns
        FROM information_schema.columns isc
        LEFT JOIN LATERAL (
          SELECT col_description(c.oid, a.attnum) AS description
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = isc.table_schema
            AND c.relname = isc.table_name
            AND a.attname = isc.column_name
            AND a.attnum > 0
        ) col_desc ON true
        WHERE isc.table_schema = t.table_schema
          AND isc.table_name = t.table_name
      ) col ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'schema', fk_sub.referenced_table_schema,
            'name', fk_sub.referenced_table_name,
            'columns', fk_sub.columns_arr
          )
        ) AS fk_agg
        FROM (
          SELECT 
            kcu.constraint_name AS fk_name,
            kcu.table_schema,
            kcu.table_name,
            ccu.table_schema AS referenced_table_schema,
            ccu.table_name AS referenced_table_name,
            json_agg(
              json_build_object(
                'source', kcu.column_name,
                'target', ccu.column_name
              )
              ORDER BY kcu.ordinal_position
            ) AS columns_arr
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name 
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu 
            ON tc.constraint_name = ccu.constraint_name 
            AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND kcu.table_schema = t.table_schema
            AND kcu.table_name = t.table_name
          GROUP BY kcu.constraint_name, kcu.table_schema, kcu.table_name,
                  ccu.table_schema, ccu.table_name
        ) fk_sub
      ) fk ON true
    ),
    stored_procedures_data AS (
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'schema', n.nspname,
            'name', p.proname,
            'signature', pg_get_function_identity_arguments(p.oid),
            'type', CASE p.prokind 
                      WHEN 'f' THEN 'function'
                      WHEN 'p' THEN 'procedure'
                      WHEN 'a' THEN 'aggregate'
                      WHEN 'w' THEN 'window'
                      ELSE 'unknown'
                    END,
            'parameters', COALESCE(params.param_array, '[]'::json)
          )
        ),
        '[]'::json
      ) AS stored_procedures
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'name', COALESCE(param.parameter_name, 'arg' || param.idx::text),
            'dataType', param.data_type,
            'maxLength', 0,
            'precision', 0,
            'scale', 0
          )
          ORDER BY param.idx
        ) AS param_array
        FROM (
          SELECT  
            row_number() OVER () AS idx,
            arg_name AS parameter_name,
            arg_type AS data_type
          FROM (
            SELECT 
              unnest(COALESCE(p.proargnames, ARRAY[]::text[])) AS arg_name,
              unnest(string_to_array(pg_get_function_identity_arguments(p.oid), ', ')) AS arg_type
          ) args
          WHERE arg_type IS NOT NULL AND arg_type != ''
        ) param
      ) params ON true
      WHERE p.prokind IN ('f', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    )
    SELECT json_build_object(
      'tables', COALESCE((SELECT tables FROM tables_data), '[]'::json),
      'storedProcedures', COALESCE((SELECT stored_procedures FROM stored_procedures_data), '[]'::json)
    ) as json_result;
    `,
    db,
  );

  return DatabaseStructureZod.parse(res);
};

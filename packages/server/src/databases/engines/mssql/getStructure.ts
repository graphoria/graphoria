import type { Database } from "../../../types/configuration";

import { DatabaseStructureZod } from "../../../types/zod/db";
import { executeQueryJSONSingle } from "./connection";

export const getDatabaseStructure = async (db: Database) => {
  const res = await executeQueryJSONSingle(
    `
      SELECT 
        (
          SELECT 
            t.[schema] as 'schema',
            t.[table] as 'name',
            t.entityType as entityType,
            (
              SELECT CAST(value AS NVARCHAR(MAX))
              FROM sys.extended_properties ep
              INNER JOIN sys.objects o ON ep.major_id = o.object_id
              WHERE ep.name = 'MS_Description'
                AND o.name = t.[table]
                AND SCHEMA_NAME(o.schema_id) = t.[schema]
                AND ep.minor_id = 0
            ) AS tableDescription,
            ISNULL((
              SELECT
                c.COLUMN_NAME AS name,
                c.DATA_TYPE AS dataType,
                CAST(CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS bit) AS isNullable,
                (
                  SELECT CAST(value AS NVARCHAR(MAX))
                  FROM sys.extended_properties ep
                  INNER JOIN sys.objects o ON ep.major_id = o.object_id
                  INNER JOIN sys.columns col ON col.object_id = o.object_id AND col.column_id = ep.minor_id
                  WHERE ep.name = 'MS_Description'
                    AND o.name = t.[table]
                    AND SCHEMA_NAME(o.schema_id) = t.[schema]
                    AND col.name = c.COLUMN_NAME
                ) AS description
              FROM INFORMATION_SCHEMA.COLUMNS AS c
              WHERE c.TABLE_SCHEMA = t.[schema]
                AND c.TABLE_NAME = t.[table]
              FOR JSON PATH
            ), '[]') AS columns,
            ISNULL((
              SELECT
                SCHEMA_NAME(tr.schema_id) AS [schema],
                tr.name AS [name],
                ISNULL((
                  SELECT
                    cp.name AS [source],
                    cr.name AS [target]
                  FROM sys.foreign_key_columns AS fkc_inner
                  JOIN sys.columns AS cp 
                    ON fkc_inner.parent_object_id = cp.object_id 
                  AND fkc_inner.parent_column_id = cp.column_id
                  JOIN sys.columns AS cr 
                    ON fkc_inner.referenced_object_id = cr.object_id 
                  AND fkc_inner.referenced_column_id = cr.column_id
                  WHERE fkc_inner.constraint_object_id = fk.object_id
                  FOR JSON PATH
                ), '[]') AS columns
              FROM sys.foreign_keys AS fk
              JOIN sys.foreign_key_columns AS fkc 
                ON fk.object_id = fkc.constraint_object_id
              JOIN sys.tables AS tp 
                ON fkc.parent_object_id = tp.object_id
              JOIN sys.tables AS tr 
                ON fkc.referenced_object_id = tr.object_id
              WHERE tp.name = t.[table]
              GROUP BY fk.object_id, fk.name, tp.name, tp.schema_id, tr.name, tr.schema_id
              FOR JSON PATH
            ), '[]') AS foreignKeys
          FROM (
            SELECT DISTINCT
              TABLE_SCHEMA AS [schema],
              TABLE_NAME AS [table],
              CASE WHEN TABLE_TYPE = 'BASE TABLE' THEN 'table' ELSE 'view' END AS entityType
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
          ) t
          FOR JSON PATH, INCLUDE_NULL_VALUES
        ) AS tables,
        (
          SELECT 
            SCHEMA_NAME(p.schema_id) AS 'schema',
            p.name AS name,
            ISNULL (
              (
                SELECT 
                  name as name,
                  TYPE_NAME(user_type_id) AS dataType,
                  max_length as maxLength,
                  precision,
                  scale
                FROM sys.parameters
                WHERE object_id = p.object_id
                ORDER BY parameter_id
                FOR JSON PATH
              ),
              '[]'
            ) AS parameters
          FROM sys.procedures p
          INNER JOIN sys.objects o ON p.object_id = o.object_id
          FOR JSON PATH, INCLUDE_NULL_VALUES
        ) AS storedProcedures
      FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    `,
    db,
  );

  return DatabaseStructureZod.parse(res);
};

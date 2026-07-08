import type { Database } from "../../../types/configuration";
import type { View } from "../../../types/db";

import { executeQueryJSONSingle } from "./connection";

export const getViewsFromDB = async (db: Database) =>
  executeQueryJSONSingle<View[]>(
    `
    SELECT 
      LOWER(SCHEMA_NAME(v.schema_id)) AS schema,
      LOWER(v.name) AS name,
      OBJECT_DEFINITION(v.object_id) AS definition
    FROM sys.views v
    FOR JSON PATH, INCLUDE_NULL_VALUES
    `,
    db,
  );

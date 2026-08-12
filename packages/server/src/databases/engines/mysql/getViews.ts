import type { Database } from "../../../types/configuration";
import type { View } from "../../../types/db";

import { executeQueryJSONSingle } from "./connection";

export const getViewsFromDB = async (db: Database) =>
  executeQueryJSONSingle<View[]>(
    `
    SELECT JSON_ARRAYAGG(
      JSON_OBJECT(
        'schema', LOWER(table_schema),
        'name', LOWER(table_name),
        'definition', view_definition
      )
    ) as json_result
    FROM information_schema.views
    WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');
    `,
    db,
  );

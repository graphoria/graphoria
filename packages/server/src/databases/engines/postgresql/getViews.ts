import type { Database } from "../../../types/configuration";
import type { View } from "../../../types/db";

import { executeQueryJSONSingle } from "./connection";

export const getViewsFromDB = async (db: Database) =>
  executeQueryJSONSingle<View[]>(
    `
    SELECT json_agg(
      json_build_object(
        'schema', lower(schemaname),
        'name', lower(viewname),
        'definition', view_definition
      )
    )
    FROM pg_views
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema');
    `,
    db,
  );

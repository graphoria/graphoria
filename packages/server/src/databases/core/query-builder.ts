import type { AnalysisResult, SelectionAnalysis } from "../../analyzeQuery/types";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { Database } from "../../types/configuration";
import type { PageLimits } from "../common";

import { databaseAdapters } from "./function-mapping";

export const generateSQL = (
  entities: MergedEntities,
  analysisResult: AnalysisResult,
  variables: Record<string, unknown> = {},
  forHashMethod: boolean = false,
  /** `null` exempts the query — operator-authored queries are configuration, not caller input. */
  pageLimits: PageLimits | null = null,
  /** Per-operation override. `undefined` leaves the engine on its own default. */
  timeoutMs?: number,
) => {
  const operation = analysisResult.operations[0];

  return operation.fields
    .reduce<[Database, SelectionAnalysis[]][]>((acc, field) => {
      const tableObj = entities.queriesMap[field.name]!;

      const dbFound = acc.find((a) => a[0].name === tableObj.db?.name);

      if (dbFound) {
        dbFound[1].push(field);
      } else {
        acc.push([tableObj.db!, [field]]);
      }

      return acc;
    }, [])
    .map(([db, fields]) => {
      const adapter = databaseAdapters[db.type];
      if (!adapter) {
        throw new Error(`Unsupported database type: ${db.type}`);
      }

      const query = adapter.query(
        entities,
        {
          ...operation,
          fields,
        },
        variables,
        forHashMethod,
        pageLimits,
        timeoutMs,
      );

      return [db, query] as const;
    });
};

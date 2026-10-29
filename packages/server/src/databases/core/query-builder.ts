import type {
  AnalysisResult,
  SelectionAnalysis,
  VariableDefinition,
} from "../../analyzeQuery/types";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { Database } from "../../types/configuration";
import type { PageLimits } from "../common";

import { databaseAdapters } from "./function-mapping";
import { compactPlaceholders } from "./placeholders";

export type GeneratedStatement = {
  db: Database;
  query: string;
  /** The definitions this statement's placeholders index into. */
  variablesDefinition: VariableDefinition[];
};

export const generateSQL = (
  entities: MergedEntities,
  analysisResult: AnalysisResult,
  variables: Record<string, unknown> = {},
  forHashMethod: boolean = false,
  /** `null` exempts the query — operator-authored queries are configuration, not caller input. */
  pageLimits: PageLimits | null = null,
  /** Per-operation override. `undefined` leaves the engine on its own default. */
  timeoutMs?: number,
): GeneratedStatement[] => {
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

      // The request numbers its variables once; a statement references only
      // its own roots' — PostgreSQL rejects the rest as untyped parameters.
      const compacted = compactPlaceholders(query, operation.variables ?? [], db.type);

      return { db, ...compacted };
    });
};

import { format as sqlFormatter } from "sql-formatter";

import type { AnalysisResult } from "../../../analyzeQuery/types";
import type { MergedEntities } from "../../../configuration/getSchemas/mergeEntities";

import { generateSQL } from "../../core/query-builder";

export const format = (sql: string) =>
  sqlFormatter(sql, {
    language: "postgresql",
    paramTypes: { custom: [{ regex: String.raw`\$\d+` }] },
  });

export const genSql = (
  entitites: MergedEntities,
  query: AnalysisResult,
  variables: Record<string, unknown> = {},
  hash = false,
) => {
  const [[, sql]] = generateSQL(entitites, query, variables, hash);

  return format(sql);
};

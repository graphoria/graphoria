import { format as sqlFormatter } from "sql-formatter";

import type { AnalysisResult } from "../../../analyzeQuery/types";
import type { MergedEntities } from "../../../configuration/getSchemas/mergeEntities";
import type { PageLimits } from "../../common";

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
  pageLimits: PageLimits | null = null,
) => {
  const [[, sql]] = generateSQL(entitites, query, variables, hash, pageLimits);

  return format(sql);
};

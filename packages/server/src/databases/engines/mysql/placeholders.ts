import type { VariableDefinition } from "../../../analyzeQuery/types";

import { rewritePlaceholders } from "../../core/placeholders";

/**
 * Rewrites the builder's PostgreSQL-style `$n` placeholders to MySQL's `?`.
 *
 * The query builders are shared across engines and number placeholders by index
 * into `variablesDefinition`. Bun's MySQL adapter binds `?` by position of
 * occurrence in the statement text, and the two orders do not match: the WHERE
 * string is interpolated into more than one sub-statement on the aggregate path,
 * nested subqueries are built before the outer WHERE is appended, and a single
 * directive can emit `$2` before `$1` and `$1` twice. Rewriting here — the one
 * point where the finished statement and its values meet — makes text order the
 * binding order by construction.
 */
export const toMySQLPlaceholders = (
  query: string,
  variablesDefinition: VariableDefinition[] = [],
  values: Record<string, unknown> = {},
): { query: string; params: unknown[] } => {
  const params: unknown[] = [];

  const rewritten = rewritePlaceholders(
    query,
    "$",
    (position) => {
      const definition = variablesDefinition[position - 1];

      if (!definition) {
        throw new Error(
          `MySQL query references $${position} but only ${variablesDefinition.length} variable${
            variablesDefinition.length === 1 ? " is" : "s are"
          } defined`,
        );
      }

      params.push(values[definition.name]);

      return "?";
    },
    { backslashEscapes: true },
  );

  return { query: rewritten, params };
};

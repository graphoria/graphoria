import type { VariableDefinition } from "../../../analyzeQuery/types";

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
 *
 * The scan skips quoted runs because generated SQL does carry `$n` inside string
 * literals: a config-supplied relationship condition value is interpolated as a
 * literal, and introspected identifiers may contain `$`.
 */
export const toMySQLPlaceholders = (
  query: string,
  variablesDefinition: VariableDefinition[] = [],
  values: Record<string, unknown> = {},
): { query: string; params: unknown[] } => {
  const params: unknown[] = [];
  let rewritten = "";
  let index = 0;

  while (index < query.length) {
    const char = query[index]!;

    if (char === "'" || char === '"' || char === "`") {
      const start = index;
      index++;

      while (index < query.length) {
        // Backslash escapes apply inside string literals but never inside a
        // backtick-quoted identifier, where the only escape is a doubled tick.
        if (char !== "`" && query[index] === "\\") {
          index += 2;
          continue;
        }
        if (query[index] === char) {
          if (query[index + 1] === char) {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }

      rewritten += query.slice(start, index);
      continue;
    }

    if (char === "$") {
      const match = /^\$(\d+)/.exec(query.slice(index));

      if (match) {
        const position = Number(match[1]);
        const definition = variablesDefinition[position - 1];

        if (!definition) {
          throw new Error(
            `MySQL query references $${position} but only ${variablesDefinition.length} variable${
              variablesDefinition.length === 1 ? " is" : "s are"
            } defined`,
          );
        }

        params.push(values[definition.name]);
        rewritten += "?";
        index += match[0].length;
        continue;
      }
    }

    rewritten += char;
    index++;
  }

  return { query: rewritten, params };
};

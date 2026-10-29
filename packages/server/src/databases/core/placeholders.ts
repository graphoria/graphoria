import type { VariableDefinition } from "../../analyzeQuery/types";
import type { DatabaseType } from "../../types/configuration";

/** The character a dialect writes before a bound parameter's position. */
export const mappingDbTypeCharVar: Record<DatabaseType, string> = {
  pg: "$",
  mysql: "$",
  mssql: "@",
  sqlite: "$",
};

/**
 * Replaces every `<prefix><n>` placeholder that sits outside a quoted run, in
 * text order.
 *
 * The scan skips quoted runs because generated SQL does carry placeholders
 * inside string literals: a config-supplied relationship condition value is
 * interpolated as a literal, and introspected identifiers may contain `$`.
 *
 * `backslashEscapes` belongs to MySQL alone: T-SQL and SQLite emit
 * `ESCAPE '\'` for LIKE, a literal that ends in a backslash, and reading that
 * backslash as an escape swallows the closing quote and everything after it.
 */
export const rewritePlaceholders = (
  query: string,
  prefix: string,
  replace: (position: number) => string,
  backslashEscapes = false,
): string => {
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
        if (backslashEscapes && char !== "`" && query[index] === "\\") {
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

    if (char === prefix) {
      let end = index + 1;

      while (end < query.length && query[end]! >= "0" && query[end]! <= "9") {
        end++;
      }

      if (end > index + 1) {
        rewritten += replace(Number(query.slice(index + 1, end)));
        index = end;
        continue;
      }
    }

    rewritten += char;
    index++;
  }

  return rewritten;
};

/**
 * Renumbers a statement's placeholders to a contiguous `1..k` and returns the
 * definitions that numbering indexes into.
 *
 * A request numbers its variables once, across every database it touches, but a
 * statement references only the ones its own roots use. PostgreSQL refuses to
 * infer a type for a parameter the statement never uses (42P18), so each
 * statement has to carry its own subset. Positions keep their original order
 * and only the gaps close, so a statement that uses every definition is left
 * exactly as the builder wrote it.
 */
export const compactPlaceholders = (
  query: string,
  variablesDefinition: VariableDefinition[],
  dbType: DatabaseType = "pg",
): { query: string; variablesDefinition: VariableDefinition[] } => {
  const prefix = mappingDbTypeCharVar[dbType];
  const backslashEscapes = dbType === "mysql";
  const referenced = new Set<number>();

  rewritePlaceholders(
    query,
    prefix,
    (position) => {
      referenced.add(position);
      return "";
    },
    backslashEscapes,
  );

  const ordered = [...referenced].sort((a, b) => a - b);
  const renumbered = new Map(ordered.map((position, index) => [position, index + 1]));

  const used = ordered.map((position) => {
    const definition = variablesDefinition[position - 1];

    if (!definition) {
      throw new Error(
        `Statement references ${prefix}${position} but only ${variablesDefinition.length} variable${
          variablesDefinition.length === 1 ? " is" : "s are"
        } defined`,
      );
    }

    return definition;
  });

  const compacted = rewritePlaceholders(
    query,
    prefix,
    (position) => {
      return `${prefix}${renumbered.get(position)!}`;
    },
    backslashEscapes,
  );

  return { query: compacted, variablesDefinition: used };
};

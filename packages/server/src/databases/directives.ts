import type { DatabaseType } from "../types/configuration";
import type { VariableDefinition } from "../analyzeQuery/types";

import { isString } from "es-toolkit/compat";

// Directive handler type
export type DirectiveHandler = (
  querySelector: string,
  directive: { name: string; arguments?: Record<string, unknown> },
  dbType: DatabaseType,
) => string;

// Wrap a value in SQL string quotes unless it's a positional placeholder ($1, @1, etc.)
const sqlString = (value: unknown): string => {
  const s = String(value);
  if (/^[$@]\d+$/.test(s)) return s;
  return `'${s}'`;
};

// Directive handlers registry
export const DIRECTIVE_HANDLERS: Record<string, DirectiveHandler> = {
  uppercase: (querySelector) => `UPPER(${querySelector})`,
  lowercase: (querySelector) => `LOWER(${querySelector})`,
  truncate: (querySelector, directive) =>
    `LEFT(${querySelector}, ${directive.arguments!["length"]})`,
  default: (querySelector, directive) =>
    `COALESCE(${querySelector}, ${sqlString(directive.arguments?.["value"] ?? "N/A")})`,
  trim: (querySelector) => `TRIM(${querySelector})`,
  ltrim: (querySelector) => `LTRIM(${querySelector})`,
  rtrim: (querySelector) => `RTRIM(${querySelector})`,
  substring: (querySelector, directive) =>
    `SUBSTRING(${querySelector}, ${directive.arguments!["start"]}, ${directive.arguments!["length"]})`,
  replace: (querySelector, directive) =>
    `REPLACE(${querySelector}, ${sqlString(directive.arguments!["find"])}, ${sqlString(directive.arguments!["replaceWith"])})`,
  concat: (querySelector, directive) => {
    const withValue = directive.arguments!["with"] as string;
    const position = (directive.arguments?.["position"] as string) ?? "after";
    return position === "before"
      ? `CONCAT(${sqlString(withValue)}, ${querySelector})`
      : `CONCAT(${querySelector}, ${sqlString(withValue)})`;
  },
  pad: (querySelector, directive, dbType) => {
    const length = directive.arguments!["length"] as number;
    const char = sqlString(directive.arguments?.["char"] ?? " ");
    const side = (directive.arguments?.["side"] as string) ?? "left";
    if (dbType === "pg") {
      return side === "left"
        ? `LPAD(${querySelector}::TEXT, ${length}, ${char})`
        : `RPAD(${querySelector}::TEXT, ${length}, ${char})`;
    } else {
      return side === "left"
        ? `RIGHT(REPLICATE(${char}, ${length}) + CAST(${querySelector} AS VARCHAR(MAX)), ${length})`
        : `LEFT(CAST(${querySelector} AS VARCHAR(MAX)) + REPLICATE(${char}, ${length}), ${length})`;
    }
  },
  dateFormat: (querySelector, directive, dbType) => {
    const format = directive.arguments!["format"] as string;
    return dbType === "pg"
      ? `TO_CHAR(${querySelector}, ${sqlString(format)})`
      : `FORMAT(${querySelector}, ${sqlString(format)})`;
  },
  round: (querySelector, directive) =>
    `ROUND(${querySelector}, ${(directive.arguments?.["decimals"] as number) ?? 0})`,
  ceil: (querySelector, directive, dbType) =>
    dbType === "pg" ? `CEIL(${querySelector})` : `CEILING(${querySelector})`,
  floor: (querySelector) => `FLOOR(${querySelector})`,
  abs: (querySelector) => `ABS(${querySelector})`,
  multiply: (querySelector, directive) => `(${querySelector} * ${directive.arguments!["by"]})`,
  divide: (querySelector, directive) => `(${querySelector} / ${directive.arguments!["by"]})`,
};

const mappingDbTypeCharVar: Record<DatabaseType, string> = {
  pg: "$",
  mysql: "$",
  mssql: "@",
};

/**
 * Apply a chain of directives to a query selector.
 * Resolves $name variable refs to positional placeholders before invoking each handler.
 */
export const applyDirectives = (
  querySelector: string,
  directives: { name: string; arguments?: Record<string, unknown> }[] | undefined,
  dbType: DatabaseType,
  variablesDefinition: VariableDefinition[] = [],
): string => {
  if (!directives?.length) return querySelector;

  return directives.reduce((query, directive) => {
    const handler = DIRECTIVE_HANDLERS[directive.name];
    if (!handler) return query;

    // Resolve $name refs (both $static_N and user $var) to positional placeholders
    const resolvedArgs =
      directive.arguments &&
      Object.fromEntries(
        Object.entries(directive.arguments).map(([key, value]) => {
          if (isString(value) && (value as string).startsWith("$")) {
            const varName = (value as string).substring(1);
            const index = variablesDefinition.findIndex((v) => v.name === varName);
            if (index >= 0) {
              return [key, `${mappingDbTypeCharVar[dbType]}${index + 1}`];
            }
          }
          return [key, value];
        }),
      );

    return handler(query, { ...directive, arguments: resolvedArgs }, dbType);
  }, querySelector);
};

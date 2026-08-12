import { z } from "zod";

/**
 * Structured JSON query input — safer for LLMs than writing raw GraphQL.
 * The server builds the correct GraphQL query internally.
 */
export const queryDataSchema = z.object({
  entity: z
    .string()
    .describe(
      "The EXACT resolverName from list_entities (e.g. 'pg_public_contacts', NOT 'contacts').",
    ),
  operation: z
    .enum(["list", "aggregate"])
    .describe("'list' for rows, 'aggregate' for grouped counts."),
  columns: z.array(z.string()).optional().describe("Columns to return. Omit for all columns."),
  groupBy: z.array(z.string()).optional().describe("Columns to group by (aggregate only)."),
  filters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Where conditions, e.g. { "deleted_at": { "is_null": true }, "role": { "eq": "admin" } }.',
    ),
  limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(100)
    .describe("Max rows to return (default 100)."),
  offset: z.number().int().min(0).optional().describe("Rows to skip."),
  orderBy: z
    .array(
      z.object({
        column: z.string(),
        direction: z
          .enum([
            "ASC",
            "DESC",
            "ASC_NULLS_FIRST",
            "ASC_NULLS_LAST",
            "DESC_NULLS_FIRST",
            "DESC_NULLS_LAST",
          ])
          .default("ASC"),
      }),
    )
    .optional()
    .describe("Sort order."),
});

export type StructuredQueryInput = z.infer<typeof queryDataSchema>;

const gqlLiteral = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(gqlLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${gqlLiteral(v)}`,
    );
    return `{ ${pairs.join(", ")} }`;
  }
  return "null";
};

/**
 * Build a read-only GraphQL query from structured JSON input.
 * Returns the query string ready for `graphql_execute`.
 */
export const buildStructuredQuery = (input: StructuredQueryInput): string => {
  const { entity, operation, columns, groupBy, filters, limit, offset, orderBy } = input;

  const args: string[] = [];
  const safeLimit = limit ?? 100;
  if (safeLimit > 0) args.push(`limit: ${safeLimit}`);
  if (offset !== undefined) args.push(`offset: ${offset}`);
  if (filters && Object.keys(filters).length > 0) {
    args.push(`where: ${gqlLiteral(filters)}`);
  }
  if (orderBy && orderBy.length > 0) {
    args.push(`orderBy: ${gqlLiteral(orderBy)}`);
  }

  const argsStr = args.length > 0 ? `(${args.join(", ")})` : "";

  if (operation === "aggregate") {
    const groupCols = groupBy && groupBy.length > 0 ? groupBy : (columns ?? []);
    if (groupCols.length === 0) {
      throw new Error("aggregate requires at least one column for groupBy or columns.");
    }
    const groupByArg = `groupBy: [${groupCols}]`;
    const aggArgs = [groupByArg];
    if (safeLimit > 0) aggArgs.push(`limit: ${safeLimit}`);
    if (filters && Object.keys(filters).length > 0) aggArgs.push(`where: ${gqlLiteral(filters)}`);

    const keyCols = groupCols.map((c) => c).join(" ");
    const itemCols = columns && columns.length > 0 ? columns.join(" ") : groupCols.join(" ");

    return `query { ${entity}_aggregate(${aggArgs.join(", ")}) { key { ${keyCols} } count items { ${itemCols} } } }`;
  }

  // list operation
  const colSelection = columns && columns.length > 0 ? columns.join(" ") : "__typename";
  return `query { ${entity}${argsStr} { ${colSelection} } }`;
};

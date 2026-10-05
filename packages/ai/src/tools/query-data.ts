import { z } from "zod";

// Every name the builder writes into the document must be one: anything else
// would be read as GraphQL syntax.
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

const graphqlName = z.string().regex(GRAPHQL_NAME, "must be a GraphQL name");

// GraphQL keeps every name starting with `__` for itself, and no column field has one.
const reservedKey = (key: string): string | null =>
  key.startsWith("__") ? `"${key}" is reserved: GraphQL keeps names starting with __` : null;

/**
 * Structured JSON query input — safer for LLMs than writing raw GraphQL.
 * The server builds the correct GraphQL query internally.
 */
export const queryDataSchema = z.object({
  entity: graphqlName.describe(
    "The EXACT resolverName from list_entities (e.g. 'pg_public_contacts', NOT 'contacts').",
  ),
  operation: z
    .enum(["list", "aggregate"])
    .describe("'list' for rows, 'aggregate' for grouped counts."),
  columns: z
    .array(graphqlName)
    .optional()
    .describe("Columns to return. Omit for every column the role can read."),
  groupBy: z.array(graphqlName).optional().describe("Columns to group by (aggregate only)."),
  filters: z
    .preprocess(
      (filters, ctx) => {
        // Checked on the raw object: the record parse drops a `__proto__` key silently.
        if (filters && typeof filters === "object") {
          for (const key of Object.keys(filters)) {
            const reserved = reservedKey(key);
            if (reserved)
              ctx.addIssue({ code: "custom", message: reserved, input: filters, path: [key] });
          }
        }
        return filters;
      },
      z.record(graphqlName, z.unknown()),
    )
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
  offset: z.number().int().min(0).optional().describe("Rows to skip (list only)."),
  orderBy: z
    .array(
      z.object({
        column: graphqlName,
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
    .describe("Sort order (list only)."),
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
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (!GRAPHQL_NAME.test(k)) throw new Error(`"${k}" is not a GraphQL name`);
      const reserved = reservedKey(k);
      if (reserved) throw new Error(reserved);
      return `${k}: ${gqlLiteral(v)}`;
    });
    return `{ ${pairs.join(", ")} }`;
  }
  return "null";
};

/**
 * Build a read-only GraphQL query from structured JSON input. A list that names
 * no column selects `defaultColumns`. Returns the query string ready for
 * `graphql_execute`.
 *
 * The input is parsed here even when the tool boundary already did: every name
 * in it is written into the document, so the builder cannot trust its caller.
 */
export const buildStructuredQuery = (
  input: StructuredQueryInput,
  defaultColumns: readonly string[] = [],
): string => {
  const { entity, operation, columns, groupBy, filters, limit, offset, orderBy } =
    queryDataSchema.parse(input);

  const args: string[] = [];
  const safeLimit = limit ?? 100;
  if (safeLimit > 0) args.push(`limit: ${safeLimit}`);
  if (offset !== undefined) args.push(`offset: ${offset}`);
  if (filters && Object.keys(filters).length > 0) {
    args.push(`where: ${gqlLiteral(filters)}`);
  }
  if (orderBy && orderBy.length > 0) {
    const terms = orderBy.map(({ column, direction }) => `{ ${column}: ${direction} }`);
    args.push(`orderBy: [${terms.join(", ")}]`);
  }

  const argsStr = args.length > 0 ? `(${args.join(", ")})` : "";

  if (operation === "aggregate") {
    // `offset: 0` skips nothing, so dropping it changes no result.
    if ((offset !== undefined && offset !== 0) || (orderBy && orderBy.length > 0)) {
      throw new Error("aggregate takes no offset or orderBy; page and sort a list instead.");
    }

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
  const selected = columns && columns.length > 0 ? columns : defaultColumns;
  if (selected.length === 0) {
    throw new Error(`list on "${entity}" needs \`columns\`: no table by that name is visible.`);
  }
  return `query { ${entity}${argsStr} { ${selected.join(" ")} } }`;
};

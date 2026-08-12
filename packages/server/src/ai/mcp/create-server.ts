import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/server";
import type { AnalyzedConfiguration } from "../../configuration";

import { GRAPHORIA_MCP_INSTRUCTIONS } from "./instructions";
import {
  describeEntityCore,
  ENTITY_KINDS,
  executeGraphqlCore,
  listEntitiesCore,
  makeValidateQuery,
  synthesizeRequest,
} from "../tools/core";
import { logger } from "../../logging";
import { buildStructuredQuery, queryDataSchema } from "../tools/query-data";

export type CreateMcpServerOptions = {
  name?: string;
  version?: string;
  maxQueryDepth?: number;
  graphqlEnabled?: boolean;
  restEnabled?: boolean;
  disabledTools?: string[];
  disabledResources?: string[];
  disabledPrompts?: string[];
};

const ANONYMOUS_ROLE = "anonymous";

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const jsonResult = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export const createMcpServer = (
  analyzedConfiguration: AnalyzedConfiguration,
  options: CreateMcpServerOptions = {},
) => {
  const {
    name = "graphoria-mcp-server",
    version = "1.0.0",
    maxQueryDepth,
    graphqlEnabled,
    restEnabled,
    disabledTools = [],
    disabledResources = [],
    disabledPrompts = [],
  } = options;

  const disabledToolSet = new Set(disabledTools);
  if (graphqlEnabled === false) disabledToolSet.add("graphql_execute");
  if (restEnabled === false) disabledToolSet.add("rest_execute");
  const disabledResourceSet = new Set(disabledResources);
  const disabledPromptSet = new Set(disabledPrompts);

  const server = new McpServer(
    { name, version },
    {
      capabilities: { logging: {} },
      instructions: GRAPHORIA_MCP_INSTRUCTIONS,
    },
  );

  const role = analyzedConfiguration.roles[ANONYMOUS_ROLE];
  if (!role) {
    throw new Error(
      `MCP server requires the '${ANONYMOUS_ROLE}' role to be present in the configuration.`,
    );
  }
  const { handlers, typeDefs, introspection } = role;

  const validateQuery = makeValidateQuery(role, maxQueryDepth);

  const registerToolIfEnabled: typeof server.registerTool = ((
    toolName: string,
    ...rest: unknown[]
  ) => {
    if (disabledToolSet.has(toolName)) return null;
    return (server.registerTool as unknown as (...a: unknown[]) => unknown)(toolName, ...rest);
  }) as typeof server.registerTool;

  const registerResourceIfEnabled: typeof server.registerResource = ((
    resourceName: string,
    uri: string,
    ...rest: unknown[]
  ) => {
    if (disabledResourceSet.has(uri) || disabledResourceSet.has(resourceName)) return null;
    return (server.registerResource as unknown as (...a: unknown[]) => unknown)(
      resourceName,
      uri,
      ...rest,
    );
  }) as typeof server.registerResource;

  const registerPromptIfEnabled: typeof server.registerPrompt = ((
    promptName: string,
    ...rest: unknown[]
  ) => {
    if (disabledPromptSet.has(promptName)) return null;
    return (server.registerPrompt as unknown as (...a: unknown[]) => unknown)(promptName, ...rest);
  }) as typeof server.registerPrompt;

  // ----- Tools -----

  registerToolIfEnabled(
    "query_data",
    {
      title: "Query Data (Structured JSON)",
      description:
        "Query data using structured JSON instead of raw GraphQL. PREFERRED over graphql_execute for list and aggregate queries — simpler, less error-prone. The server builds the correct GraphQL query internally from your JSON input.",
      inputSchema: queryDataSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const query = buildStructuredQuery(args as Parameters<typeof buildStructuredQuery>[0]);
        const outcome = await executeGraphqlCore(role, validateQuery, {
          query,
        });
        switch (outcome.kind) {
          case "non_query":
            return errorResult("Internal: built query is not a query.");
          case "validation":
            return jsonResult({ data: null, errors: outcome.errors });
          case "error":
            return errorResult(`Error executing query: ${outcome.message}`);
          case "ok":
            return jsonResult(outcome.result);
        }
      } catch (error) {
        return errorResult(
          `Error building query: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  registerToolIfEnabled(
    "graphql_execute",
    {
      title: "Execute GraphQL Query",
      description:
        "Executes a GraphQL query against the anonymous-role schema. Mutations and subscriptions are rejected. Returns { data, errors } JSON.",
      inputSchema: z.object({
        query: z.string().describe("GraphQL query string"),
        variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL variables map"),
      }),
    },
    async ({ query, variables }): Promise<CallToolResult> => {
      const outcome = await executeGraphqlCore(role, validateQuery, {
        query,
        variables,
      });
      switch (outcome.kind) {
        case "non_query":
          return errorResult(
            "Only `query` operations are allowed via MCP. Mutations and subscriptions are rejected.",
          );
        case "validation":
          return jsonResult({ data: null, errors: outcome.errors });
        case "error":
          return errorResult(`Error executing query: ${outcome.message}`);
        case "ok":
          return jsonResult(outcome.result);
      }
    },
  );

  registerToolIfEnabled(
    "graphql_validate",
    {
      title: "Validate GraphQL Query",
      description:
        "Validates a GraphQL query against the anonymous-role schema without executing it. Returns { valid, errors }.",
      inputSchema: z.object({
        query: z.string().describe("GraphQL query string"),
      }),
    },
    async ({ query }): Promise<CallToolResult> => {
      try {
        const { hasErrors, validationErrors } = validateQuery(query);
        return jsonResult({
          valid: !hasErrors,
          errors: validationErrors.map((e) => ({
            message: e.message,
            locations: e.locations,
          })),
        });
      } catch (error) {
        return jsonResult({
          valid: false,
          errors: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        });
      }
    },
  );

  registerToolIfEnabled(
    "list_entities",
    {
      title: "List Entities",
      description:
        "Lists entities exposed to the anonymous role: tables, operations, remote schemas, remote REST APIs, stored procedures, queue publishers. Requires at least one of `kind` or `search` — calling with no arguments is rejected to keep result sets focused. Use `kind` to browse a category, `search` to find by name fragment, or both together.",
      inputSchema: z
        .object({
          kind: z
            .enum(ENTITY_KINDS)
            .optional()
            .describe("Filter to one category. Required unless `search` is provided."),
          search: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Case-insensitive substring match. For tables, matches against resolverName, raw schema/table name, AND tableDescription — useful when the DB has cryptic names but rich descriptions. For operations, matches name and description. Required unless `kind` is provided.",
            ),
        })
        .refine((v) => v.kind !== undefined || v.search !== undefined, {
          message:
            'list_entities requires at least one of `kind` or `search`. Pick a kind to browse a category (e.g. kind: "table") or supply a search term (e.g. search: "user").',
        }),
    },
    async ({ kind, search }): Promise<CallToolResult> => {
      try {
        if (kind === undefined && (search === undefined || search === "")) {
          return errorResult(
            'list_entities requires at least one of `kind` or `search`. Pick a kind (e.g. kind: "table") or supply a search term.',
          );
        }
        return jsonResult(listEntitiesCore(role, { kind, search }));
      } catch (error) {
        return errorResult(
          `Error listing entities: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  registerToolIfEnabled(
    "describe_entity",
    {
      title: "Describe Entity",
      description:
        "Returns detailed information about an entity. For tables, includes columns, relationships, the generated GraphQL list-field and _aggregate-field signatures, and ready-to-run example queries (list / filter / aggregate) using this table's real column names. For remote schemas/REST, includes their imported SDL/OpenAPI shape.",
      inputSchema: z.object({
        name: z.string().describe("Entity name (e.g. resolverName for tables)"),
        kind: z.enum(ENTITY_KINDS).optional(),
      }),
    },
    async ({ name, kind }): Promise<CallToolResult> => {
      try {
        const result = describeEntityCore(role, { name, kind });
        if (!result)
          return errorResult(kind ? `${kind} '${name}' not found.` : `Entity '${name}' not found.`);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          `Error describing entity: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  registerToolIfEnabled(
    "rest_execute",
    {
      title: "Execute REST Request",
      description:
        "Executes a request against the anonymous-role REST handler. `path` is the path under the REST prefix (e.g. /users/123). Body is auto-JSON-stringified.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
        path: z.string().describe("Path relative to the REST prefix"),
        query: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    },
    async ({ method, path, query, body, headers }): Promise<CallToolResult> => {
      try {
        const url = new URL(path, "http://mcp.local");
        if (query) {
          for (const [k, v] of Object.entries(query)) {
            url.searchParams.append(k, v);
          }
        }

        const init: RequestInit & { body?: BodyInit | null } = {
          method,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(headers ?? {}),
          },
        };
        if (body !== undefined) {
          init.body = typeof body === "string" ? body : JSON.stringify(body);
        }

        const req = synthesizeRequest(url.toString(), init);
        const response = await handlers.rest.handler(url, url.pathname, method, req);

        const text = await response.text();
        let parsedBody: unknown = text;
        try {
          parsedBody = JSON.parse(text);
        } catch {
          // Keep as text
        }

        const headersOut: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headersOut[k] = v;
        });

        return jsonResult({
          status: response.status,
          headers: headersOut,
          body: parsedBody,
        });
      } catch (error) {
        return errorResult(
          `Error executing REST request: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  // ----- Resources -----

  registerResourceIfEnabled(
    "graphql-schema",
    "graphql://schema",
    {
      title: "GraphQL Schema (SDL)",
      description: "Anonymous-role GraphQL schema in SDL format.",
      mimeType: "text/plain",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: typeDefs }],
    }),
  );

  registerResourceIfEnabled(
    "graphql-introspection",
    "graphql://introspection",
    {
      title: "GraphQL Introspection",
      description: "Anonymous-role GraphQL introspection result (JSON).",
      mimeType: "application/json",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(introspection, null, 2),
        },
      ],
    }),
  );

  registerResourceIfEnabled(
    "openapi-spec",
    "openapi://spec",
    {
      title: "OpenAPI Spec",
      description: "Unified OpenAPI specification (operations + remote-REST).",
      mimeType: "application/json",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(analyzedConfiguration.openapi, null, 2),
        },
      ],
    }),
  );

  // ----- Prompts -----

  registerPromptIfEnabled(
    "db_query",
    {
      title: "Database Query",
      description:
        "Answer a database question using the Graphoria MCP tools. Injects the user's question plus a workflow reminder (list_entities → describe_entity → graphql_execute) and the aggregate-syntax rules.",
      argsSchema: z.object({
        question: z.string().describe("Natural-language question about the database."),
      }),
    },
    ({ question }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Database-query request from the user:

> ${question}

Use the Graphoria MCP tools to answer. Required workflow:

1. list_entities — REQUIRES \`kind\` or \`search\`. Search matches resolverName AND tableDescription, so try natural-language keywords even when DB names are cryptic.
2. describe_entity — read the table's columns, the aggregateField signature, AND \`examples.list / examples.filter / examples.aggregate\` (these are pre-built queries using this table's real column names; prefer copying them over composing from scratch).
3. graphql_validate (optional) — confirm a hand-written query parses before executing.
4. graphql_execute — run the query.

For counts, totals, aggregates, grouping, breakdowns, or summaries: ALWAYS use \`<entity>_aggregate\` with \`groupBy\`. NEVER fetch all rows with the list field and count client-side. NEVER use Hasura-style \`{ aggregate { count } }\` nesting — that field does not exist.

Aggregate shape (\`key\` is an object, must be sub-selected):

  query {
    <entity>_aggregate(groupBy: [<col>]) {
      key { <col> }
      count
      items { <fields> }
    }
  }

For a grand total: groupBy the primary key (or any non-null column) and sum the per-group \`count\` values client-side.

Present grouped results as a Markdown table with the grouped-by column(s) and the count.`,
          },
        },
      ],
    }),
  );

  server.server.onerror = (err: unknown) => {
    logger("mcp").error({ err }, "server error");
  };

  return server;
};

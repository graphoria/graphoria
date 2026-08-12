import { z } from "zod";

import type { RoleEntities } from "./core";
import type { Tool } from "../agent/types";

import {
  describeEntityCore,
  ENTITY_KINDS,
  executeGraphqlCore,
  listEntitiesCore,
  makeValidateQuery,
} from "./core";
import { buildStructuredQuery, queryDataSchema } from "./query-data";
import type { StructuredQueryInput } from "./query-data";

/**
 * Build the agent's tool set against a compiled role schema. The agent reaches
 * the database ONLY through these tools, so it inherits that role's visibility.
 * `graphql_execute` must keep its name — the agent loop's anti-hallucination
 * guard recognises it as a data-access tool.
 */
/** Preserve per-tool schema inference, then widen to the heterogeneous `Tool`. */
const tool = <T extends z.ZodTypeAny>(t: Tool<T>): Tool => t as unknown as Tool;

export const buildAgentTools = (role: RoleEntities): Tool[] => {
  const validateQuery = makeValidateQuery(role);

  return [
    tool({
      name: "list_entities",
      description:
        "Lists entities exposed to this role: tables, operations, remote schemas, remote REST APIs, stored procedures, queue publishers. Requires at least one of `kind` or `search`. Use `kind` to browse a category, `search` to find by name fragment (matches resolverName AND table descriptions).",
      schema: z.object({
        kind: z.enum(ENTITY_KINDS).optional(),
        search: z.string().min(1).optional(),
      }),
      execute: async ({ kind, search }) => {
        if (kind === undefined && (search === undefined || search === "")) {
          return {
            error:
              'list_entities requires at least one of `kind` or `search`. Pick a kind (e.g. kind: "table") or supply a search term.',
          };
        }
        return listEntitiesCore(role, { kind, search });
      },
    }),
    tool({
      name: "describe_entity",
      description:
        "Returns detailed information about an entity. For tables: columns, relationships, the generated GraphQL list-field and _aggregate-field signatures, and ready-to-run example queries (list / filter / aggregate) using the table's real column names.",
      schema: z.object({
        name: z.string(),
        kind: z.enum(ENTITY_KINDS).optional(),
      }),
      execute: async ({ name, kind }) => {
        const result = describeEntityCore(role, { name, kind });
        return result ?? { error: `Entity '${name}' not found.` };
      },
    }),
    tool({
      name: "query_data",
      description:
        "Query data using structured JSON instead of raw GraphQL. PREFERRED over graphql_execute for list and aggregate queries — simpler, less error-prone. The server builds the query internally from your JSON input.",
      schema: queryDataSchema,
      execute: async (args) => {
        const query = buildStructuredQuery(args as StructuredQueryInput);
        const outcome = await executeGraphqlCore(role, validateQuery, {
          query,
        });
        switch (outcome.kind) {
          case "non_query":
            return { error: "Internal: built query is not a query." };
          case "validation":
            return { data: null, errors: outcome.errors };
          case "error":
            return { error: outcome.message };
          case "ok":
            return outcome.result;
        }
      },
    }),
    tool({
      name: "graphql_execute",
      description:
        "Executes a read-only GraphQL query against this role's schema. Mutations and subscriptions are rejected. Returns { data, errors }.",
      schema: z.object({
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ query, variables }) => {
        const outcome = await executeGraphqlCore(role, validateQuery, {
          query,
          variables,
        });
        switch (outcome.kind) {
          case "non_query":
            return {
              error:
                "Only `query` operations are allowed. Mutations and subscriptions are rejected.",
            };
          case "validation":
            return { data: null, errors: outcome.errors };
          case "error":
            return { error: outcome.message };
          case "ok":
            return outcome.result;
        }
      },
    }),
  ];
};

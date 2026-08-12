import { isString } from "es-toolkit";
import { parse, specifiedRules, validate } from "graphql";
import { LRUCache } from "lru-cache";

import type { BunRequest } from "bun";
import type { DocumentNode, GraphQLError } from "graphql";
import type { AnalysisResult, SelectionAnalysis } from "../../analyzeQuery/types";
import type { GetGQLEntitiesReturn } from "../../configuration/getSchemas";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { Auth } from "../../types/configuration";
import type { SessionContext } from "../../utils/sessionVariables";

import { analyzeQuery } from "../../analyzeQuery";
import { depthLimitRule } from "../../analyzeQuery/depthLimit";
import { resolveVariableRef, resolveVariables } from "../../analyzeQuery/resolveVariables";
import { callStoredProcedure, executeQueryJSON, generateSQL } from "../../databases";
import { proxyRemoteField } from "../../remoteSchemas/proxy";
import { getAgent } from "../../singletons/ai";
import { databasesConnections, repositoryMap } from "../../singletons/databases";
import { env } from "../../singletons/env";
import { queueManager } from "../../singletons/queues";
import { EntitySource } from "../../types/resolver";
import { filterResultBySelection } from "../../utils/selection";
import { handleAuthMeQuery, handleAuthMutation } from "./gqlAuthOperations";
import { logger } from "../../logging";

// Handle GraphQL query
export const handleGraphQLRequestFactory = (
  entities: MergedEntities,
  gqlEntities: GetGQLEntitiesReturn,
  auth: Auth | null = null,
) => {
  // Mutation handlers by source type
  const mutationHandlers: Partial<
    Record<
      EntitySource,
      (
        field: SelectionAnalysis,
        variables: Record<string, unknown>,
        queryAnalysis: AnalysisResult,
        req?: BunRequest,
        session?: SessionContext,
      ) => Promise<{ data: object }>
    >
  > = {
    [EntitySource.QUEUE_PUBLISHER]: async (field, variables) => {
      const data = resolveVariableRef(variables, field.arguments?.data);

      const publisher = entities.queuesMap[field.name];

      if (!publisher) {
        throw new Error(`Queue publisher not found: ${field.name}`);
      }

      return {
        data: {
          [field.alias || field.name]: await queueManager?.sendMessage(
            publisher.resolverName,
            data?.toString() ?? "",
          ),
        },
      };
    },

    [EntitySource.AUTH]: (field, variables, _queryAnalysis, req, session) =>
      handleAuthMutation(field, variables, auth, req, session),

    [EntitySource.OPERATION]: async (field, variables) => {
      const operation = entities.operations[field.name];

      if (!operation?.handler) {
        throw new Error(`Operation handler not found for: ${field.name}`);
      }

      const argumentsReplaced = Object.fromEntries(
        Object.entries(field.arguments?.input ?? {}).map(([key, value]) => [
          key,
          resolveVariableRef(variables, value),
        ]),
      );

      const result = await operation.handler(
        {
          databases: databasesConnections,
          gqlQuery: gql.handler,
          queues: queueManager,
          repository: repositoryMap,
        },
        argumentsReplaced,
      );

      // Filter result based on requested fields
      const filteredResult = filterResultBySelection(result, field.selections);

      return {
        data: {
          [field.alias || field.name]: filteredResult,
        },
      };
    },

    [EntitySource.STORED_PROCEDURE]: async (field, variables, queryAnalysis) => {
      const sp = entities.mutationsMap[field.name];

      if (!sp) {
        throw new Error(`Stored procedure not found: ${field.name}`);
      }

      const argumentsReplaced = Object.fromEntries(
        Object.entries(field.arguments ?? {}).map(([key, value]) => [
          key,
          resolveVariableRef(variables, value),
        ]),
      );

      const result = await callStoredProcedure(
        sp,
        queryAnalysis.operations[0].variables ?? [],
        argumentsReplaced as Record<string, string | number | boolean | null>,
      );

      return {
        data: {
          [field.alias || field.name]: result,
        },
      };
    },

    [EntitySource.REMOTE_SCHEMA]: async (field, variables, _queryAnalysis, req) => {
      const entry = entities.remoteMutationsMap[field.name];

      if (!entry) {
        throw new Error(`Remote schema mutation not found: ${field.name}`);
      }

      const result = await proxyRemoteField(
        field,
        entry.remoteSchema,
        entry.originalFieldName,
        variables,
        "mutation",
        req,
      );

      return {
        data: {
          [field.alias || field.name]: result,
        },
      };
    },
  };

  // Per-role LRU cache: keyed on raw query string, one entry per query enriched in
  // place as the pipeline progresses (parse → validate → analyze). Caching validation
  // is safe because the schema and depth rule are fixed for the factory's lifetime;
  // if hot schema-reload is ever added, this cache must be dropped on reload.
  interface CachedQuery {
    document: DocumentNode;
    validationErrors?: readonly GraphQLError[];
    analysis?: AnalysisResult;
  }

  const queryCache = new LRUCache<string, CachedQuery>({ max: 1000 });

  // undefined = unparseable query (never cached)
  const getCacheEntry = (query: string): CachedQuery | undefined => {
    const hit = queryCache.get(query);
    if (hit) return hit;
    try {
      const entry: CachedQuery = { document: parse(query) };
      queryCache.set(query, entry);
      return entry;
    } catch {
      return undefined;
    }
  };

  const isIntrospectionAST = (document: DocumentNode): boolean =>
    document.definitions.some(
      (def) =>
        def.kind === "OperationDefinition" &&
        def.selectionSet.selections.some(
          (sel) => sel.kind === "Field" && sel.name.value === "__schema",
        ),
    );

  const isNoDataAST = (document: DocumentNode): boolean =>
    document.definitions.some(
      (def) =>
        def.kind === "OperationDefinition" &&
        def.selectionSet.selections.some(
          (sel) => sel.kind === "Field" && sel.name.value === "_no_data",
        ),
    );

  const gql = {
    // Check if the query is an introspection query (AST-based, not substring)
    isIntrospectionQuery: (query: string) => {
      const entry = getCacheEntry(query);
      return entry ? isIntrospectionAST(entry.document) : false;
    },
    // Check if the query is a _no_data query (AST-based, not substring)
    isNoDataQuery: (query: string) => {
      const entry = getCacheEntry(query);
      return entry ? isNoDataAST(entry.document) : false;
    },
    // Return the introspection result for clients like GraphiQL or Apollo Client
    introspectionResult: { data: gqlEntities.introspection },
    noDataResult: { data: { _no_data: "No data available" } },
    hasErrors: (query: string) => {
      const entry = getCacheEntry(query);
      // Unparseable queries aren't cached; let parse surface the syntax error
      const document = entry?.document ?? parse(query);

      let validationErrors = entry?.validationErrors;
      if (!validationErrors) {
        const rules =
          env.maxQueryDepth > 0
            ? [...specifiedRules, depthLimitRule(env.maxQueryDepth)]
            : undefined; // undefined = use default specifiedRules

        validationErrors = validate(gqlEntities.schema, document, rules);
        if (entry) entry.validationErrors = validationErrors;
      }

      return {
        hasErrors: validationErrors.length > 0,
        validationErrors,
      };
    },
    // Handle the GraphQL query
    handler: async (
      query: string | AnalysisResult,
      variables: Record<string, unknown> = {},
      req?: BunRequest,
      session?: SessionContext,
      // oxlint-disable-next-line typescript/no-explicit-any
    ): Promise<{ data: any }> => {
      const log = logger("graphql").child({ role: session?.role });
      const startTime = Bun.nanoseconds();

      // Reuse cached analysis on repeated identical queries
      const entry = isString(query) ? getCacheEntry(query) : undefined;
      let queryAnalysis: AnalysisResult;
      if (entry?.analysis) {
        queryAnalysis = entry.analysis;
      } else {
        queryAnalysis = isString(query) ? analyzeQuery(query, entities, gqlEntities.schema) : query;
        if (entry) entry.analysis = queryAnalysis;
      }

      if (queryAnalysis.operations.length === 0) {
        return { data: {} };
      }

      const operation = queryAnalysis.operations[0];
      log.debug(
        {
          operation: operation.operation,
          name: operation.name,
          fieldCount: operation.fields?.length,
          queryLength: isString(query) ? query.length : undefined,
        },
        "graphql request",
      );

      // Single pass: validate, flatten object vars, resolve field args + session vars
      // Returns an immutable ResolvedOperation — original operation is not mutated
      const resolved = resolveVariables(operation, variables, session);

      if (operation.operation === "query") {
        // Separate auth fields, remote schema fields, and table fields
        const authFields = resolved.fields.filter((field) => field.source === EntitySource.AUTH);
        const remoteFields = resolved.fields.filter(
          (field) => field.source === EntitySource.REMOTE_SCHEMA,
        );
        const aiFields = resolved.fields.filter((field) => field.source === EntitySource.AI);
        const tableFields = resolved.fields.filter(
          (field) =>
            field.source !== EntitySource.AUTH &&
            field.source !== EntitySource.REMOTE_SCHEMA &&
            field.source !== EntitySource.AI,
        );

        // Handle auth queries (e.g. auth_me)
        let authData: Record<string, unknown> = {};
        for (const field of authFields) {
          Object.assign(authData, handleAuthMeQuery(field, session));
        }

        // Handle remote schema queries in parallel
        let remoteData: Record<string, unknown> = {};
        if (remoteFields.length > 0) {
          const remoteResults = await Promise.all(
            remoteFields.map(async (field) => {
              const entry = entities.remoteQueriesMap[field.name];
              if (!entry) {
                throw new Error(`Remote schema query not found: ${field.name}`);
              }
              const result = await proxyRemoteField(
                field,
                entry.remoteSchema,
                entry.originalFieldName,
                resolved.allVariables,
                "query",
                req,
              );
              return { [field.alias || field.name]: result };
            }),
          );
          remoteData = remoteResults.reduce((acc, curr) => Object.assign(acc, curr), {});
        }

        // Handle AI agent queries (admin-only `ask` field)
        let aiData: Record<string, unknown> = {};
        for (const field of aiFields) {
          const alias = field.alias || field.name;
          const prompt = field.arguments?.prompt;
          aiData[alias] = await getAgent()(String(prompt ?? ""));
        }

        // Skip SQL generation if there are no table fields
        if (tableFields.length === 0) {
          log.debug(
            { durationMs: (Bun.nanoseconds() - startTime) / 1e6 },
            "graphql request completed (no table fields)",
          );
          return { data: { ...authData, ...remoteData, ...aiData } };
        }

        const tableQueryAnalysis = {
          ...queryAnalysis,
          operations: [
            {
              ...operation,
              fields: tableFields,
              variables: resolved.variables,
            },
          ],
        };

        const sqlQueries = generateSQL(entities, tableQueryAnalysis, resolved.allVariables);

        const data = await Promise.all<object>(
          sqlQueries.map(([db, query]) =>
            executeQueryJSON(
              query,
              db,
              resolved.variables,
              resolved.allVariables as Record<string, string | number | boolean | null>,
            ),
          ),
        );

        log.debug(
          { durationMs: (Bun.nanoseconds() - startTime) / 1e6, dbCount: sqlQueries.length },
          "graphql request completed",
        );

        return {
          ...(env.queryOnResponse
            ? {
                sqlQueries: sqlQueries.map(([db, query]) => ({
                  db: db.name,
                  query,
                })),
              }
            : {}),
          data: data.reduce((acc, curr) => Object.assign(acc, curr), {
            ...authData,
            ...remoteData,
            ...aiData,
          }),
        };
      } else if (operation.operation === "mutation") {
        // Route mutation to the appropriate handler based on field source
        let results: Record<string, object> = {};

        for await (const field of resolved.fields) {
          const source = field.source;

          if (source && mutationHandlers[source]) {
            const result = await mutationHandlers[source]!(
              field,
              resolved.allVariables,
              queryAnalysis,
              req,
              session,
            );

            results = {
              ...results,
              ...result.data,
            };
          }
        }

        log.debug(
          { durationMs: (Bun.nanoseconds() - startTime) / 1e6 },
          "graphql request completed",
        );

        return {
          data: results,
        };
      }

      return { data: {} };
    },
  };

  return gql;
};

export type HandleGraphQLRequest = ReturnType<typeof handleGraphQLRequestFactory>;

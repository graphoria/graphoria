import { isString } from "es-toolkit";
import { OverlappingFieldsCanBeMergedRule, parse, specifiedRules, validate } from "graphql";
import { LRUCache } from "lru-cache";

import type { BunRequest } from "bun";
import type { DocumentNode, GraphQLError } from "graphql";
import type { RoleEntities } from "../../ai/adapter";
import type { AnalysisResult, SelectionAnalysis } from "../../analyzeQuery/types";
import type { SchemaEntities } from "../../configuration/getSchemas";
import type { Auth } from "../../types/configuration";
import type { SessionContext } from "../../utils/sessionVariables";

import { analyzeQuery } from "../../analyzeQuery";
import { checkQueryCost } from "../../analyzeQuery/costLimit";
import { depthLimitRule, isDepthLimitError } from "../../analyzeQuery/depthLimit";
import { resolveVariableRef, resolveVariables } from "../../analyzeQuery/resolveVariables";
import { callStoredProcedure, executeQueryJSON, generateSQL } from "../../databases";
import { filterBasedOnDirective } from "../../databases/common";
import { proxyRemoteField } from "../../remoteSchemas/proxy";
import { getAgent } from "../../singletons/ai";
import { actorFromSession, audit } from "../../logging/audit";
import { databasesConnections, repositoryMap } from "../../singletons/databases";
import { env } from "../../singletons/env";
import { queueManager } from "../../singletons/queues";
import { EntitySource } from "../../types/resolver";
import { filterResultBySelection } from "../../utils/selection";
import { handleAuthMeQuery, handleAuthMutation } from "./gqlAuthOperations";
import { logger } from "../../logging";
import { incMetric, isMetricsEnabled, observeMetric } from "../../observability/metrics";
import { startSpan, withActiveSpan } from "../../observability/tracing";

// Handle GraphQL query
export const handleGraphQLRequestFactory = (entities: SchemaEntities, auth: Auth | null = null) => {
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
    [EntitySource.QUEUE_PUBLISHER]: async (field, variables, _queryAnalysis, _req, session) => {
      const data = resolveVariableRef(variables, field.arguments?.data);

      const publisher = entities.queuesMap[field.name];

      if (!publisher) {
        throw new Error(`Queue publisher not found: ${field.name}`);
      }

      audit().emit({
        action: "queue.publish",
        actor: actorFromSession(session),
        target: { kind: "publisher", name: publisher.resolverName },
      });

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
          gqlQuery: operatorQuery,
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

    [EntitySource.STORED_PROCEDURE]: async (field, variables, queryAnalysis, _req, session) => {
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
        argumentsReplaced as Record<string, string | number | boolean | null>,
        {
          operation: {
            type: "mutation",
            name: queryAnalysis.operations[0]?.name ?? null,
            fields: [field.name],
          },
          role: session?.role,
        },
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
    /**
     * SQL memoized for one resolved-variable layout. The fingerprint is the
     * ordered definition names: object-variable flattening and session-claim
     * binding mint static_N definitions per request, so different layouts emit
     * different placeholder numbering and need their own SQL text.
     */
    sqlMemo?: { fingerprint: string; queries: ReturnType<typeof generateSQL> };
  }

  const queryCache = new LRUCache<string, CachedQuery>({ max: 1000 });

  const pageLimits = { defaultPageSize: env.defaultPageSize, maxPageSize: env.maxPageSize };

  // Per-role pino children: roles are bounded, so the logger stops being a
  // per-request allocation after each role's first request.
  const roleLoggers = new Map<string, ReturnType<typeof logger>>();
  const logFor = (role: string | undefined) => {
    const key = role ?? "";
    const existing = roleLoggers.get(key);
    if (existing) return existing;
    const created = logger("graphql").child({ role });
    roleLoggers.set(key, created);
    return created;
  };

  // Results are merged by assignment (last write wins) and nothing here checks
  // the spec's field-merging constraints, so the overlap rule only rejects
  // queries the engine would otherwise execute — while being the one rule whose
  // cost grows quadratically with wide selection sets.
  const validationRules = specifiedRules.filter(
    (rule) => rule !== OverlappingFieldsCanBeMergedRule,
  );

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

  // These directives resolve against request values, so their verdicts change
  // the emitted SQL per request; documents carrying them are never memoized.
  const CONTROL_FLOW_DIRECTIVES = new Set(["skip", "include", "when"]);
  const hasControlFlowDirectives = (analysis: AnalysisResult): boolean => {
    const selectionsHave = (fields: SelectionAnalysis[]): boolean =>
      fields.some(
        (field) =>
          field.directives?.some((directive) => CONTROL_FLOW_DIRECTIVES.has(directive.name)) ===
            true ||
          (field.selections !== undefined && selectionsHave(field.selections)),
      );
    return analysis.operations.some(
      (operation) => operation.fields !== undefined && selectionsHave(operation.fields),
    );
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
    introspectionResult: { data: entities.introspection },
    noDataResult: { data: { _no_data: "No data available" } },
    // `enforceDepthLimit: false` and `enforceCostLimit: false` are for
    // operator-authored queries (REST operations), which are config, not
    // attacker input. The depth verdict is never cached under them: the cache is
    // keyed on query text alone, so storing a depth-free verdict would serve a
    // caller sending the same text over the wire.
    //
    // Two flags rather than one because they are exempted for the same reason
    // but enforced in different places — the depth rule inside the memoised
    // `validate`, the cost check after it. Overloading one flag would leave the
    // REST call sites reading as if they only exempted depth.
    hasErrors: (
      query: string,
      options?: {
        enforceDepthLimit?: boolean;
        enforceCostLimit?: boolean;
        variables?: Record<string, unknown>;
      },
    ) => {
      const enforceDepthLimit = options?.enforceDepthLimit ?? true;
      const enforceCostLimit = options?.enforceCostLimit ?? true;
      let costRejected = false;
      const entry = getCacheEntry(query);
      // Unparseable queries aren't cached; let parse surface the syntax error
      const document = entry?.document ?? parse(query);

      let validationErrors = enforceDepthLimit ? entry?.validationErrors : undefined;
      if (!validationErrors) {
        const maxDepth = enforceDepthLimit ? env.maxQueryDepth : 0;
        const rules =
          maxDepth > 0 ? [...validationRules, depthLimitRule(maxDepth)] : validationRules;

        validationErrors = validate(entities.schema, document, rules);
        if (entry && enforceDepthLimit) entry.validationErrors = validationErrors;
      }

      // Outside the block above, and never cached: the estimate depends on the
      // request's variable values, so the same query text has different verdicts
      // for different callers. Only for a query that already typechecks — an
      // estimate drawn from a document that does not resolve against the schema
      // would bury the error that actually explains the rejection.
      if (enforceCostLimit && env.maxQueryCost > 0 && validationErrors.length === 0) {
        const costError = checkQueryCost(
          document,
          entities.schema,
          options?.variables ?? {},
          pageLimits,
          env.maxQueryCost,
        );

        if (costError) {
          validationErrors = [costError];
          costRejected = true;
        }
      }

      if (validationErrors.length > 0) {
        incMetric("graphoria_graphql_rejections_total", {
          reason: costRejected
            ? "cost"
            : validationErrors.some(isDepthLimitError)
              ? "depth"
              : "validation",
        });
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
      // `enforcePageLimits: false` is for operator-authored queries (REST
      // operations, cron jobs, the `gqlQuery` handed to operation hooks). They
      // are configuration, not caller input, so a page cap could only reject
      // the operator's own intent. Use `gql.operatorQuery` rather than passing
      // this by hand.
      //
      // `timeoutMs` is the per-operation override only. Left undefined, each
      // engine stays on its own default — the pool's on Postgres and SQL
      // Server, QUERY_TIMEOUT_MS on MySQL, which has no pool-level route — so
      // an ordinary caller query is bounded without the factory resolving
      // anything.
      options?: { enforcePageLimits?: boolean; timeoutMs?: number },
      // oxlint-disable-next-line typescript/no-explicit-any
    ): Promise<{ data: any }> => {
      const log = logFor(session?.role);
      const startTime = Bun.nanoseconds();

      // Reuse cached analysis on repeated identical queries
      const analyzeSpan = startSpan("graphoria.analyze");
      const entry = isString(query) ? getCacheEntry(query) : undefined;
      let queryAnalysis: AnalysisResult;
      if (entry?.analysis) {
        queryAnalysis = entry.analysis;
        analyzeSpan?.setAttribute("graphoria.analysis.cached", true);
      } else {
        queryAnalysis = isString(query) ? analyzeQuery(query, entities) : query;
        if (entry) entry.analysis = queryAnalysis;
        analyzeSpan?.setAttribute("graphoria.analysis.cached", false);
      }
      analyzeSpan?.end();

      if (queryAnalysis.operations.length === 0) {
        return { data: {} };
      }

      const operation = queryAnalysis.operations[0];
      // An anonymous operation is named by its root fields, exactly as the slow
      // query log names one: the document itself would carry inline literals,
      // which are caller data.
      const operationName =
        operation.name ?? (operation.fields ?? []).map((field) => field.name).join(",");
      const role = session?.role ?? "anonymous";
      const recordOperation = (outcome: "success" | "error") => {
        if (!isMetricsEnabled()) return;
        const labels = {
          operation: operationName,
          type: operation.operation,
          role,
        };
        incMetric("graphoria_graphql_operations_total", { ...labels, outcome });
        observeMetric(
          "graphoria_graphql_operation_duration_seconds",
          labels,
          (Bun.nanoseconds() - startTime) / 1e9,
        );
      };
      let outcome: "success" | "error" = "success";
      const span = startSpan(`${operation.operation} ${operationName}`, {
        attributes: {
          "graphql.operation.name": operationName,
          "graphql.operation.type": operation.operation,
          "graphoria.role": role,
        },
      });

      // The span is entered rather than passed: the statements this operation
      // runs reach the executor through call chains that carry no span, and the
      // async context is what joins them to this one.
      return withActiveSpan(span, async () => {
        try {
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
            const authFields = resolved.fields.filter(
              (field) => field.source === EntitySource.AUTH,
            );
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

            // Every `ask` is settled before any field runs, so a refused prompt costs
            // no remote call. Not from `resolved.allVariables`: it also holds what the
            // server binds (role-filter constants, `$session` claims), which a prompt
            // naming `$static_N` would hand to the LLM and the audit record.
            const callerValues =
              aiFields.length > 0
                ? {
                    ...Object.fromEntries(
                      (operation.variables ?? [])
                        .filter((variable) => variable.defaultValue !== undefined)
                        .map((variable) => [variable.name, variable.defaultValue]),
                    ),
                    ...variables,
                  }
                : {};

            // A skipped `ask` runs no agent, as a skipped table field selects nothing.
            const runningAsks = aiFields.filter((field) =>
              filterBasedOnDirective(field, operation.variables ?? [], callerValues),
            );

            // Each `ask` runs a whole agent loop, while the rate limiter counts
            // the request once.
            if (runningAsks.length > 1) {
              throw new Error("Only one `ask` is allowed per request");
            }

            const asks = runningAsks.map((field) => {
              const prompt = resolveVariableRef(callerValues, field.arguments?.prompt);
              if (typeof prompt !== "string" || prompt.length === 0) {
                throw new Error("`prompt` (string) is required");
              }
              return { field, prompt };
            });

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

            // Handle AI agent queries (the `ask` field of a role granted `ai`)
            let aiData: Record<string, unknown> = {};
            for (const { field, prompt } of asks) {
              const alias = field.alias || field.name;
              audit().emit({
                action: "ai.ask",
                actor: actorFromSession(session),
                target: { kind: "ai", via: "graphql" },
                prompt,
              });
              aiData[alias] = await getAgent()(prompt, { role: asAgentRole(), session, req });
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

            const sqlQueries = (() => {
              // The SQL text is a pure function of the resolved definition
              // layout — values ride as bound parameters — so a repeated query
              // skips the rebuild. Only the caller path: operator-authored
              // queries exempt page limits, and MySQL inlines a per-request
              // timeout hint, both of which change the text.
              const enforcePageLimits = options?.enforcePageLimits ?? true;
              const memoizable = enforcePageLimits && !hasControlFlowDirectives(queryAnalysis);
              const fingerprint = resolved.variables
                .map((variable) => variable.name)
                .join("\u0000");
              const memo = entry?.sqlMemo;

              if (memoizable && memo !== undefined && memo.fingerprint === fingerprint) {
                return memo.queries;
              }

              const queries = generateSQL(
                entities,
                tableQueryAnalysis,
                resolved.allVariables,
                false,
                enforcePageLimits ? pageLimits : null,
                options?.timeoutMs,
              );

              if (memoizable && entry !== undefined && memo === undefined) {
                entry.sqlMemo = { fingerprint, queries };
              }

              return queries;
            })();

            const data = await Promise.all<object>(
              sqlQueries.map(([db, query]) =>
                executeQueryJSON(
                  query,
                  db,
                  resolved.variables,
                  resolved.allVariables as Record<string, string | number | boolean | null>,
                  options?.timeoutMs,
                  {
                    operation: {
                      type: operation.operation,
                      name: operation.name,
                      fields: tableFields.map((field) => field.name),
                    },
                    role: session?.role,
                  },
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
        } catch (error) {
          outcome = "error";
          span?.recordError(error);
          throw error;
        } finally {
          recordOperation(outcome);
          span?.end();
        }
      });
    },
  };

  // The agent's tools read through this role, so an `ask` answers with what the
  // caller's own queries would return.
  const asAgentRole = (): RoleEntities => ({ ...entities, handlers: { gql } });

  /**
   * `handler` for operator-authored queries — REST operations, cron jobs, and
   * the `gqlQuery` handed to operation hooks and handlers. Their text comes from
   * configuration, never from a caller, so page limits do not apply.
   */
  const operatorQuery = (
    query: Parameters<typeof gql.handler>[0],
    variables?: Parameters<typeof gql.handler>[1],
    req?: Parameters<typeof gql.handler>[2],
    session?: Parameters<typeof gql.handler>[3],
    timeoutMs?: number,
  ) => gql.handler(query, variables, req, session, { enforcePageLimits: false, timeoutMs });

  return { ...gql, operatorQuery };
};

export type HandleGraphQLRequest = ReturnType<typeof handleGraphQLRequestFactory>;

import type { AnalysisResult, VariableDefinition } from "../../analyzeQuery/types";
import type { GetSchemaReturn } from "../../configuration/getSchemas";
import type { QuerySource } from "../../logging/slowQuery";
import type { Database } from "../../types/configuration";
import type { DatabasePoller, QueryEventEmitter } from "../types";

import { executeQuery, executeQueryJSON, generateSQL } from "../../databases";
import { logger } from "../../logging";
import { withSpan } from "../../observability/tracing";
import { env } from "../../singletons/env";

export interface DatabasePollerConfig {
  analysis: AnalysisResult;
  variableDefinitions: VariableDefinition[];
  variables: Record<string, unknown>;
  schemaEntity: GetSchemaReturn;
  subscriptionKey: string;
  eventEmitter: QueryEventEmitter;
  pollIntervalMs?: number;
  role?: string | undefined;
}

/**
 * Get the first field name from analysis
 */
const getFirstFieldName = (analysis: AnalysisResult): string | undefined => {
  return analysis.operations[0]?.fields[0]?.name;
};

/**
 * Compute hash of query results for change detection
 */
const getResultHash = async (
  queryHash: string,
  db: Database,
  variableDefinitions: VariableDefinition[],
  variables: Record<string, unknown>,
  source: QuerySource,
): Promise<string> => {
  const hashResult = await executeQuery<{ ResultHash: string }>(
    queryHash,
    db,
    variableDefinitions,
    variables,
    undefined,
    source,
  );
  return Buffer.from(hashResult[0].ResultHash)?.toString("hex");
};

/**
 * Create a database poller that detects changes via hash comparison
 */
export const createDatabasePoller = async (
  config: DatabasePollerConfig,
): Promise<DatabasePoller> => {
  const {
    analysis,
    variableDefinitions,
    variables,
    schemaEntity,
    subscriptionKey,
    eventEmitter,
    pollIntervalMs = 1000,
    role,
  } = config;

  const firstFieldName = getFirstFieldName(analysis);
  const db = schemaEntity.queriesMap[firstFieldName!]!.db!;

  // Generate SQL queries (data query and hash query). A subscription query is
  // caller-authored, so it carries the same page bounds an HTTP query does.
  const pageLimits = { defaultPageSize: env.defaultPageSize, maxPageSize: env.maxPageSize };
  const [[, queryData]] = generateSQL(schemaEntity, analysis, variables, false, pageLimits);
  const [[, queryHash]] = generateSQL(schemaEntity, analysis, variables, true, pageLimits);

  const operation = analysis.operations[0];
  const source: QuerySource = {
    operation: {
      type: operation.operation,
      name: operation.name,
      fields: operation.fields.map((field) => field.name),
    },
    role,
  };

  // A poll is not inside a request, so each one roots its own trace. The span is
  // entered, which is what puts the statements it runs underneath it. An empty
  // poll still gets a span — an empty poll that is slow is worth seeing.
  const pollSpan = <T>(run: () => Promise<T>) =>
    withSpan(
      "subscription.poll",
      {
        parent: null,
        attributes: {
          "graphql.operation.name": source.operation.name ?? undefined,
          "graphql.operation.type": source.operation.type,
          "graphoria.role": source.role,
        },
      },
      run,
    );

  // Get initial hash and send initial data
  let previousHash = "";

  await pollSpan(async () => {
    previousHash = await getResultHash(queryHash, db, variableDefinitions, variables, source);

    eventEmitter.sendDataUpdate(subscriptionKey, {
      data: await executeQueryJSON(
        queryData,
        db,
        variableDefinitions,
        variables,
        undefined,
        source,
      ),
    });
  });

  // Poll function that checks for changes
  const log = logger("polling").child({ subscription: subscriptionKey });
  const poll = () =>
    pollSpan(async () => {
      try {
        const currentHash = await getResultHash(
          queryHash,
          db,
          variableDefinitions,
          variables,
          source,
        );

        if (currentHash !== previousHash) {
          log.info(
            { changed: !!previousHash, operation: analysis.operations[0].name },
            previousHash ? "data changed" : "initial fetch",
          );

          previousHash = currentHash;

          eventEmitter.sendDataUpdate(subscriptionKey, {
            data: await executeQueryJSON(
              queryData,
              db,
              variableDefinitions,
              variables,
              undefined,
              source,
            ),
          });
        }
      } catch (error) {
        log.error({ err: error }, "polling failed");
      }
    });

  // Poller control
  let stopped = false;
  let scheduledTimeout: Timer;

  const poller: DatabasePoller = {
    start() {
      if (stopped) return;

      scheduledTimeout = setTimeout(() => {
        poll();
        poller.start();
      }, pollIntervalMs);

      return scheduledTimeout;
    },
    stop() {
      stopped = true;
      clearTimeout(scheduledTimeout);
    },
  };

  return poller;
};

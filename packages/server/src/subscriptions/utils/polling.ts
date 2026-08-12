import type { AnalysisResult, VariableDefinition } from "../../analyzeQuery/types";
import type { GetSchemaReturn } from "../../configuration/getSchemas";
import type { Database } from "../../types/configuration";
import type { DatabasePoller, QueryEventEmitter } from "../types";

import { executeQuery, executeQueryJSON, generateSQL } from "../../databases";
import { logger } from "../../logging";

export interface DatabasePollerConfig {
  analysis: AnalysisResult;
  variableDefinitions: VariableDefinition[];
  variables: Record<string, unknown>;
  schemaEntity: GetSchemaReturn;
  subscriptionKey: string;
  eventEmitter: QueryEventEmitter;
  pollIntervalMs?: number;
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
): Promise<string> => {
  const hashResult = await executeQuery<{ ResultHash: string }>(
    queryHash,
    db,
    variableDefinitions,
    variables,
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
  } = config;

  const firstFieldName = getFirstFieldName(analysis);
  const db = schemaEntity.queriesMap[firstFieldName!]!.db!;

  // Generate SQL queries (data query and hash query)
  const [[, queryData]] = generateSQL(schemaEntity, analysis, variables);
  const [[, queryHash]] = generateSQL(schemaEntity, analysis, variables, true);

  // Get initial hash and send initial data
  let previousHash = await getResultHash(queryHash, db, variableDefinitions, variables);

  eventEmitter.sendDataUpdate(subscriptionKey, {
    data: await executeQueryJSON(queryData, db, variableDefinitions, variables),
  });

  // Poll function that checks for changes
  const log = logger("polling").child({ subscription: subscriptionKey });
  const poll = async () => {
    try {
      const currentHash = await getResultHash(queryHash, db, variableDefinitions, variables);

      if (currentHash !== previousHash) {
        log.info(
          { changed: !!previousHash, operation: analysis.operations[0].name },
          previousHash ? "data changed" : "initial fetch",
        );

        previousHash = currentHash;

        eventEmitter.sendDataUpdate(subscriptionKey, {
          data: await executeQueryJSON(queryData, db, variableDefinitions, variables),
        });
      }
    } catch (error) {
      log.error({ err: error }, "polling failed");
    }
  };

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

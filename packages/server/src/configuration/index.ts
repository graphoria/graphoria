import { isFunction, isPlainObject } from "es-toolkit";
import { z } from "zod";

import type { Configuration } from "../types/configuration";
import type { Env } from "../types/env";

import { logger } from "../logging";
import type { GetSchemaReturn } from "./getSchemas";

import { operation } from "../config";
import { getDatabasesStructure, sourcesForEachRole } from "../databases";
import { resolveRemoteRESTApis } from "../remoteREST";
import { resolveRemoteSchemas } from "../remoteSchemas";
import {
  createOneToBooleanMSSQL,
  createYAndNToBooleanMSSQL,
  virtualColumnExpression,
  virtualColumnFunction,
} from "../types/configuration";
import { getSchema, getSchemas } from "./getSchemas";
import { generateOpenAPI } from "./rest/generateOpenAPI";

export const loadConfiguration = async (config: string): Promise<Configuration> => {
  try {
    // Dynamic import of the TypeScript file
    const configModule = await import(config);

    if (isFunction(configModule?.default)) {
      return configModule.default({
        z,
        operation,
        createOneToBooleanMSSQL,
        createYAndNToBooleanMSSQL,
        virtualColumnExpression,
        virtualColumnFunction,
      });
    } else if (isPlainObject(configModule.default)) {
      return configModule.default as Configuration;
    }

    throw new Error("Invalid configuration module");
  } catch (error) {
    logger("configuration").error({ err: error }, "failed to import configuration");

    throw new Error("Configuration could not be loaded");
  }
};

export const analyzeConfiguration = async (configuration: Configuration, options: Env) => {
  const log = logger("configuration");
  log.info("starting configuration analysis");

  // Use pre-calculated enabledDatabases from configuration parsing
  const enabledDatabases = configuration.enabledDatabases;

  const [{ tables, storedProcedures }, resolvedRemoteSchemas, resolvedRemoteREST] =
    await Promise.all([
      getDatabasesStructure(enabledDatabases, configuration.auth),
      resolveRemoteSchemas(configuration.remoteSchemas ?? []),
      resolveRemoteRESTApis(configuration.remoteREST ?? []),
    ]);

  const operationsWithRestEndpoints = Object.fromEntries(
    Object.entries(configuration.operations).filter(([, operationConfig]) => operationConfig.rest),
  );

  const sourcesByPermission = sourcesForEachRole(
    tables,
    storedProcedures,
    configuration.queues,
    operationsWithRestEndpoints,
    {
      [options.anonymousRole]: {
        tables: [],
        storedProcedures: [],
        queues: [],
        operations: [],
        remoteSchemas: [],
        remoteREST: [],
      },
      ...(configuration.auth.permissions ?? {}),
      superadmin: {
        tables: "ALL",
        storedProcedures: "ALL",
        queues: "ALL",
        operations: "ALL",
        remoteSchemas: "ALL",
        remoteREST: "ALL",
      },
    },
    resolvedRemoteSchemas,
    resolvedRemoteREST,
  );

  const { superadmin, ...others } = sourcesByPermission;

  const superadminSchema = getSchema(
    superadmin,
    configuration.auth,
    null,
    configuration.ai?.enabled ?? false,
  );

  const schemas: Record<string, GetSchemaReturn> = {
    superadmin: superadminSchema,
    ...getSchemas(others, configuration.auth, superadminSchema.handlers.gql),
  };

  const jsonOpenApi = generateOpenAPI({
    title: configuration.name,
    version: configuration.version,
    schema: schemas.superadmin,
    options,
    remoteRESTApis: schemas.superadmin.remoteRESTApis,
    ai: configuration.ai?.enabled ? { path: configuration.ai.endpoint ?? "/ai" } : undefined,
  });

  log.info(
    {
      roles: Object.keys(schemas).length,
      tables: tables.length,
      storedProcedures: storedProcedures.length,
      remoteSchemas: resolvedRemoteSchemas.length,
      remoteREST: resolvedRemoteREST.length,
    },
    "configuration analysis complete",
  );

  return {
    databases: enabledDatabases,
    roles: schemas,
    openapi: jsonOpenApi,
    queues: configuration.queues,
    auth: configuration.auth,
  };
};

export type AnalyzedConfiguration = Awaited<ReturnType<typeof analyzeConfiguration>>;

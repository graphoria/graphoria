import { isAbsolute, resolve } from "path";

import { isFunction, isPlainObject, isString } from "es-toolkit";
import { z } from "zod";

import type { ConfigurationHelpers, ConfigurationInput } from "../config";
import type { Configuration, ConfigurationSource } from "../types/configuration";
import type { Env } from "../types/env";
import type { OpenAPIV3_1 } from "openapi-types";

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
import { collectCrossReferenceErrors } from "./crossReferences";
import { getSchema, getSchemas } from "./getSchemas";
import { generateOpenAPI } from "./rest/generateOpenAPI";
import { resolveAISurfaces } from "../singletons/ai";
import { setCaches } from "../singletons/cache";

const configurationHelpers: ConfigurationHelpers = {
  z,
  operation,
  createOneToBooleanMSSQL,
  createYAndNToBooleanMSSQL,
  virtualColumnExpression,
  virtualColumnFunction,
};

const importDefault = async (config: string): Promise<unknown> => {
  // A dynamic import() with a relative specifier resolves against this module,
  // not the project root. Resolve relative paths against the process cwd (the
  // project root) so CONFIGURATION="graphoria.ts" works like an absolute path.
  const configPath = isAbsolute(config) ? config : resolve(process.cwd(), config);

  // import() would name this module as the importer of the missing file.
  if (!(await Bun.file(configPath).exists())) throw new Error(`no file at ${configPath}`);

  const configModule = await import(configPath);
  if (!("default" in configModule)) throw new Error(`no default export in ${configPath}`);
  return configModule.default;
};

/**
 * Resolves a configuration source to the object its function returns, or to
 * the object itself: a path is imported for its default export first.
 */
export const loadConfiguration = async (
  source: ConfigurationSource,
): Promise<ConfigurationInput> => {
  try {
    const configuration = isString(source) ? await importDefault(source) : source;

    // Awaited inside the try: a function that rejects is wrapped like one that throws.
    if (isFunction(configuration)) return await configuration(configurationHelpers);
    if (isPlainObject(configuration)) return configuration as ConfigurationInput;

    const namespace =
      typeof configuration === "object" && configuration !== null && "default" in configuration;
    throw new Error(
      `Invalid configuration: expected the configuration function or a plain object${namespace ? "; pass the module's default export" : ""}`,
    );
  } catch (error) {
    // The message carries the reason: callers print it, and pino cannot
    // serialize the error an import that does not resolve throws.
    throw new Error(
      `Configuration could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

export const assertDistinctRoles = ({
  superadmin,
  anonymousRole,
}: Pick<Env, "superadmin" | "anonymousRole">) => {
  if (superadmin.role === anonymousRole) {
    throw new Error(
      `SUPERADMIN_ROLE and ANONYMOUS_ROLE are both "${anonymousRole}": every caller without a credential would read as the full-access role`,
    );
  }
};

// The enabled remotes that did not resolve: the boot warns and goes on without them.
const leftOut = (
  configs: { name: string; enabled?: boolean }[],
  resolved: { config: { name: string } }[],
) =>
  configs
    .filter((config) => config.enabled !== false)
    .filter((config) => !resolved.some((remote) => remote.config.name === config.name))
    .map(({ name }) => name);

export const analyzeConfiguration = async (configuration: Configuration, options: Env) => {
  const log = logger("configuration");
  log.info("starting configuration analysis");

  // buildApiRoutes reads it for every cached operation, once per role.
  setCaches(configuration.caches);

  // Use pre-calculated enabledDatabases from configuration parsing
  const enabledDatabases = configuration.enabledDatabases;

  const [
    { tables, storedProcedures, tableNamesByDatabase },
    resolvedRemoteSchemas,
    resolvedRemoteREST,
  ] = await Promise.all([
    getDatabasesStructure(enabledDatabases, configuration.auth),
    resolveRemoteSchemas(configuration.remoteSchemas ?? []),
    resolveRemoteRESTApis(configuration.remoteREST ?? []),
  ]);

  const crossReferenceErrors = collectCrossReferenceErrors(configuration, {
    tables,
    storedProcedures,
    tableNamesByDatabase,
  });

  if (crossReferenceErrors.length) {
    throw new Error(
      `Configuration references ${crossReferenceErrors.length} name${
        crossReferenceErrors.length === 1 ? "" : "s"
      } that do not exist:\n${crossReferenceErrors.map((error) => `  - ${error}`).join("\n")}`,
    );
  }

  const operationsWithRestEndpoints = Object.fromEntries(
    Object.entries(configuration.operations).filter(([, operationConfig]) => operationConfig.rest),
  );

  // A disabled queue neither connects nor serves fields; permissions may still name it.
  const enabledQueues = configuration.queues.filter((queue) => queue.enabled);

  const superadminRole = options.superadmin.role;

  const sourcesByPermission = sourcesForEachRole(
    tables,
    storedProcedures,
    enabledQueues,
    operationsWithRestEndpoints,
    {
      [options.anonymousRole]: {
        tables: {},
        storedProcedures: [],
        queues: [],
        operations: [],
        remoteSchemas: [],
        remoteREST: [],
        ai: false,
      },
      ...(configuration.auth.permissions ?? {}),
      [superadminRole]: {
        tables: "ALL",
        storedProcedures: "ALL",
        queues: "ALL",
        operations: "ALL",
        remoteSchemas: "ALL",
        remoteREST: "ALL",
        ai: true,
      },
    },
    resolvedRemoteSchemas,
    resolvedRemoteREST,
  );

  const { [superadminRole]: superadmin, ...others } = sourcesByPermission;

  const aiSurfaces = resolveAISurfaces(options, configuration.ai);

  const superadminSchema = getSchema(superadmin, configuration.auth, null, aiSurfaces.ask);

  const schemas: Record<string, GetSchemaReturn> = {
    [superadminRole]: superadminSchema,
    ...getSchemas(others, configuration.auth, superadminSchema.handlers.gql, aiSurfaces.ask),
  };

  // One document per role, built on first use: MCP shows each caller its own.
  const openapiByRole = new Map<string, OpenAPIV3_1.Document>();
  const openapiFor = (role: string): OpenAPIV3_1.Document => {
    const cached = openapiByRole.get(role);
    if (cached) return cached;

    const document = generateOpenAPI({
      title: configuration.name,
      version: configuration.version,
      role: schemas[role],
      options,
      ai:
        aiSurfaces.rest && schemas[role].entityOfRole.ai
          ? { path: configuration.ai.endpoint }
          : undefined,
    });
    openapiByRole.set(role, document);
    return document;
  };

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
    openapi: openapiFor(superadminRole),
    openapiFor,
    queues: enabledQueues,
    auth: configuration.auth,
    leftOutRemotes: {
      remoteSchemas: leftOut(configuration.remoteSchemas ?? [], resolvedRemoteSchemas),
      remoteREST: leftOut(configuration.remoteREST ?? [], resolvedRemoteREST),
    },
  };
};

export type AnalyzedConfiguration = Awaited<ReturnType<typeof analyzeConfiguration>>;

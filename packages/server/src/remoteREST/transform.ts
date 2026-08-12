import type { RemoteRESTConfig } from "../config";
import type { OpenAPIV3_1 } from "openapi-types";
import type { RemoteRESTResolved, RemoteRESTRoute } from "./types";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;

/**
 * Resolve the base URL for proxying from config or spec
 */
const resolveBaseUrl = (config: RemoteRESTConfig, spec: OpenAPIV3_1.Document): string => {
  if (config.url) return config.url.replace(/\/$/, "");

  const serverUrl = spec.servers?.[0]?.url;
  if (serverUrl) return serverUrl.replace(/\/$/, "");

  throw new Error(
    `Remote REST "${config.name}" requires a base URL: set "url" in config or ensure the spec has a "servers" entry`,
  );
};

/**
 * Prefix all $ref strings in an object tree: #/components/schemas/Foo becomes #/components/schemas/{prefix}_Foo
 */
const prefixRefs = (obj: unknown, prefix: string): unknown => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map((item) => prefixRefs(item, prefix));

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        value.startsWith("#/components/schemas/")
      ) {
        const schemaName = value.slice("#/components/schemas/".length);
        result[key] = `#/components/schemas/${prefix}_${schemaName}`;
      } else {
        result[key] = prefixRefs(value, prefix);
      }
    }
    return result;
  }

  return obj;
};

/**
 * Transform a parsed OpenAPI spec into a RemoteRESTResolved with prefixed paths and schemas
 */
export const transformRemoteREST = (
  spec: OpenAPIV3_1.Document,
  config: RemoteRESTConfig,
): RemoteRESTResolved => {
  const prefix = config.prefix ?? config.name;
  const baseUrl = resolveBaseUrl(config, spec);

  const routes: RemoteRESTRoute[] = [];
  const openApiPaths: Record<string, OpenAPIV3_1.PathItemObject> = {};
  const openApiSchemas: Record<string, OpenAPIV3_1.SchemaObject> = {};

  // Extract and prefix paths
  if (spec.paths) {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem) continue;

      const prefixedPath = `/${prefix}${path}`;
      const prefixedPathItem: OpenAPIV3_1.PathItemObject = {};

      for (const method of HTTP_METHODS) {
        const operation = (pathItem as Record<string, unknown>)[method] as
          | OpenAPIV3_1.OperationObject
          | undefined;
        if (!operation) continue;

        routes.push({
          method,
          originalPath: path,
          prefixedPath,
          operationId: operation.operationId,
          description: operation.summary ?? operation.description,
          tags: operation.tags,
        });

        // Prefix $refs in the operation and add remote API tag
        const prefixedOperation = prefixRefs(operation, prefix) as OpenAPIV3_1.OperationObject;
        prefixedOperation.tags = [prefix];

        (prefixedPathItem as Record<string, unknown>)[method] = prefixedOperation;
      }

      // Copy shared parameters (path-level) if they exist
      if (pathItem.parameters) {
        prefixedPathItem.parameters = prefixRefs(
          pathItem.parameters,
          prefix,
        ) as OpenAPIV3_1.ParameterObject[];
      }

      openApiPaths[prefixedPath] = prefixedPathItem;
    }
  }

  // Extract and prefix component schemas
  if (spec.components?.schemas) {
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      if (!schema) continue;
      openApiSchemas[`${prefix}_${name}`] = prefixRefs(schema, prefix) as OpenAPIV3_1.SchemaObject;
    }
  }

  return {
    config,
    prefix,
    baseUrl,
    routes,
    openApiPaths,
    openApiSchemas,
  };
};

import type { RemoteRESTConfig } from "../config";
import type { OpenAPIV3_1 } from "openapi-types";

/**
 * A single route extracted from a remote OpenAPI spec
 */
export type RemoteRESTRoute = {
  /** HTTP method (lowercase) */
  method: string;
  /** Original path from the spec (e.g. /users/{id}) */
  originalPath: string;
  /** Path with prefix (e.g. /payments/users/{id}) */
  prefixedPath: string;
  /** operationId from the spec, if present */
  operationId?: string;
  /** Human-readable description */
  description?: string;
  /** Tags from the spec */
  tags?: string[];
};

/**
 * Fully resolved remote REST API after spec parsing and transformation
 */
export type RemoteRESTResolved = {
  /** The original configuration */
  config: RemoteRESTConfig;
  /** Effective prefix (subpath under /rest) */
  prefix: string;
  /** Base URL for proxying requests */
  baseUrl: string;
  /** All routes extracted from the spec */
  routes: RemoteRESTRoute[];
  /** Prefixed OpenAPI paths for merging into the unified spec */
  openApiPaths: Record<string, OpenAPIV3_1.PathItemObject>;
  /** Prefixed component schemas for merging */
  openApiSchemas: Record<string, OpenAPIV3_1.SchemaObject>;
};

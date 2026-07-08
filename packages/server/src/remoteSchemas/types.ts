import type { RemoteSchemaConfig } from "../config";

/**
 * A resolved remote query or mutation field from introspection
 */
export type RemoteSchemaField = {
  /** Original field name (without prefix) */
  originalName: string;
  /** Prefixed field name used in the merged schema */
  prefixedName: string;
  /** GraphQL SDL for this field (with arguments) in the merged schema */
  sdl: string;
  /** Whether this field is a query or mutation */
  kind: "query" | "mutation";
};

/**
 * Mapping from prefixed type name to original type name
 */
export type PrefixMap = {
  /** Map prefixed name → original name */
  toOriginal: Record<string, string>;
  /** Map original name → prefixed name */
  toPrefixed: Record<string, string>;
};

/**
 * Fully resolved remote schema after introspection and transformation
 */
export type RemoteSchemaResolved = {
  /** The original configuration */
  config: RemoteSchemaConfig;
  /** Effective prefix (with trailing underscore) */
  prefix: string;
  /** Transformed SDL type definitions (prefixed types, inputs, enums, etc.) */
  typeDefsSDL: string;
  /** Remote query fields (prefixed) */
  queryFields: RemoteSchemaField[];
  /** Remote mutation fields (prefixed) */
  mutationFields: RemoteSchemaField[];
  /** Type name prefix mapping */
  prefixMap: PrefixMap;
};

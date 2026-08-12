import {
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";

import type { RemoteSchemaConfig } from "../config";
import type {
  GraphQLArgument,
  GraphQLField,
  GraphQLNamedType,
  GraphQLSchema,
  GraphQLType,
} from "graphql";
import type { PrefixMap, RemoteSchemaField, RemoteSchemaResolved } from "./types";

// Built-in GraphQL scalar names that must not be prefixed
const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

// Built-in introspection types
const INTROSPECTION_TYPES = new Set([
  "__Schema",
  "__Type",
  "__Field",
  "__InputValue",
  "__EnumValue",
  "__Directive",
  "__DirectiveLocation",
]);

/**
 * Determine if a named type should be prefixed
 */
const shouldPrefix = (typeName: string): boolean =>
  !BUILTIN_SCALARS.has(typeName) && !INTROSPECTION_TYPES.has(typeName);

/**
 * Prefix a type name if it should be prefixed
 */
const prefixTypeName = (name: string, prefix: string): string =>
  shouldPrefix(name) ? `${prefix}${name}` : name;

/**
 * Convert a GraphQL type reference to SDL string with prefixing
 */
const typeToSDL = (type: GraphQLType, prefix: string): string => {
  if (isNonNullType(type)) {
    return `${typeToSDL(type.ofType, prefix)}!`;
  }
  if (isListType(type)) {
    return `[${typeToSDL(type.ofType, prefix)}]`;
  }
  const named = type as GraphQLNamedType;
  return prefixTypeName(named.name, prefix);
};

/**
 * Convert a GraphQL argument to SDL string
 */
const argumentToSDL = (arg: GraphQLArgument, prefix: string): string => {
  const typeStr = typeToSDL(arg.type, prefix);
  if (arg.defaultValue !== undefined) {
    return `${arg.name}: ${typeStr} = ${JSON.stringify(arg.defaultValue)}`;
  }
  return `${arg.name}: ${typeStr}`;
};

/**
 * Generate SDL for a field's arguments
 */
const argsToSDL = (args: readonly GraphQLArgument[], prefix: string): string =>
  args.length ? `(${args.map((a) => argumentToSDL(a, prefix)).join(", ")})` : "";

/**
 * Generate SDL for an object type (type or input)
 */
const objectTypeToSDL = (type: GraphQLNamedType, prefix: string): string => {
  if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields());
    const fieldLines = fields.map((f) => `  ${f.name}: ${typeToSDL(f.type, prefix)}`).join("\n");
    return `input ${prefixTypeName(type.name, prefix)} {\n${fieldLines}\n}`;
  }

  if (isObjectType(type)) {
    const fields = Object.values(type.getFields());
    const fieldLines = fields
      .map((f) => {
        const args = argsToSDL(f.args, prefix);
        return `  ${f.name}${args}: ${typeToSDL(f.type, prefix)}`;
      })
      .join("\n");
    return `type ${prefixTypeName(type.name, prefix)} {\n${fieldLines}\n}`;
  }

  if (isEnumType(type)) {
    const values = type.getValues();
    const valueLines = values.map((v) => `  ${v.name}`).join("\n");
    return `enum ${prefixTypeName(type.name, prefix)} {\n${valueLines}\n}`;
  }

  if (isUnionType(type)) {
    const members = type
      .getTypes()
      .map((t) => prefixTypeName(t.name, prefix))
      .join(" | ");
    return `union ${prefixTypeName(type.name, prefix)} = ${members}`;
  }

  if (isScalarType(type) && shouldPrefix(type.name)) {
    return `scalar ${prefixTypeName(type.name, prefix)}`;
  }

  return "";
};

/**
 * Build a RemoteSchemaField from a GraphQL field
 */
const buildRemoteField = (
  field: GraphQLField<unknown, unknown>,
  prefix: string,
  kind: "query" | "mutation",
): RemoteSchemaField => {
  const args = argsToSDL(field.args, prefix);
  const returnType = typeToSDL(field.type, prefix);
  const prefixedName = `${prefix}${field.name}`;

  return {
    originalName: field.name,
    prefixedName,
    sdl: `${prefixedName}${args}: ${returnType}`,
    kind,
  };
};

/**
 * Collect all named types reachable from the schema (excluding built-ins and introspection types)
 */
const collectUserTypes = (schema: GraphQLSchema): GraphQLNamedType[] => {
  const typeMap = schema.getTypeMap();
  return Object.values(typeMap).filter(
    (type) =>
      shouldPrefix(type.name) &&
      type.name !== "Query" &&
      type.name !== "Mutation" &&
      type.name !== "Subscription",
  );
};

/**
 * Transform a remote GraphQL schema by applying a prefix to all types and fields.
 * Returns a RemoteSchemaResolved containing the transformed SDL, field mappings, and prefix map.
 */
export const transformRemoteSchema = (
  schema: GraphQLSchema,
  config: RemoteSchemaConfig,
): RemoteSchemaResolved => {
  const prefix = config.prefix ?? `${config.name}_`;

  // Collect all user-defined types
  const userTypes = collectUserTypes(schema);

  // Build prefix map
  const prefixMap: PrefixMap = {
    toOriginal: {},
    toPrefixed: {},
  };

  for (const type of userTypes) {
    const prefixed = prefixTypeName(type.name, prefix);
    prefixMap.toOriginal[prefixed] = type.name;
    prefixMap.toPrefixed[type.name] = prefixed;
  }

  // Generate SDL for all types
  const typeSDLs = userTypes.map((type) => objectTypeToSDL(type, prefix)).filter(Boolean);

  // Extract query fields
  const queryType = schema.getQueryType();
  const queryFields: RemoteSchemaField[] = [];
  if (queryType) {
    const fields = queryType.getFields();
    for (const field of Object.values(fields)) {
      queryFields.push(buildRemoteField(field, prefix, "query"));
    }
  }

  // Extract mutation fields
  const mutationType = schema.getMutationType();
  const mutationFields: RemoteSchemaField[] = [];
  if (mutationType) {
    const fields = mutationType.getFields();
    for (const field of Object.values(fields)) {
      mutationFields.push(buildRemoteField(field, prefix, "mutation"));
    }
  }

  return {
    config,
    prefix,
    typeDefsSDL: typeSDLs.join("\n\n"),
    queryFields,
    mutationFields,
    prefixMap,
  };
};

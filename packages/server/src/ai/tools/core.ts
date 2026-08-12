import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLUnionType,
  parse,
  printType,
  specifiedRules,
  validate,
} from "graphql";

import type { BunRequest } from "bun";
import type { GraphQLNamedType, GraphQLSchema } from "graphql";
import type { GetSchemaReturn } from "../../configuration/getSchemas";

import { depthLimitRule } from "../../analyzeQuery/depthLimit";
import { categorizeSqlType, isNumericType, SqlTypeCategory } from "../../databases/sqlTypeUtils";

/**
 * A per-role compiled schema bundle (tables, operations, handlers, …).
 * Shared by the MCP server and the AI agent — both query the same surface.
 */
export type RoleEntities = GetSchemaReturn;

export const ENTITY_KINDS = [
  "table",
  "operation",
  "remote_schema",
  "remote_rest",
  "stored_procedure",
  "queue_publisher",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const synthesizeRequest = (
  url: string,
  init?: RequestInit & { body?: BodyInit | null },
): BunRequest => new Request(url, init) as unknown as BunRequest;

export const containsNonQueryOperation = (query: string): boolean => {
  const document = parse(query);
  return document.definitions.some(
    (def) => def.kind === "OperationDefinition" && def.operation !== "query",
  );
};

const describeNamedType = (type: GraphQLNamedType): Record<string, unknown> => {
  if (type instanceof GraphQLObjectType || type instanceof GraphQLInterfaceType) {
    return {
      kind: type instanceof GraphQLObjectType ? "object" : "interface",
      name: type.name,
      description: type.description ?? null,
      fields: Object.values(type.getFields()).map((f) => ({
        name: f.name,
        type: f.type.toString(),
        description: f.description ?? null,
        args: f.args.map((a) => ({ name: a.name, type: a.type.toString() })),
      })),
    };
  }
  if (type instanceof GraphQLInputObjectType) {
    return {
      kind: "input",
      name: type.name,
      fields: Object.values(type.getFields()).map((f) => ({
        name: f.name,
        type: f.type.toString(),
      })),
    };
  }
  if (type instanceof GraphQLEnumType) {
    return {
      kind: "enum",
      name: type.name,
      values: type.getValues().map((v) => v.name),
    };
  }
  if (type instanceof GraphQLUnionType) {
    return {
      kind: "union",
      name: type.name,
      types: type.getTypes().map((t) => t.name),
    };
  }
  if (type instanceof GraphQLScalarType) {
    return { kind: "scalar", name: type.name };
  }
  const fallback = type as GraphQLNamedType;
  return { kind: "unknown", name: fallback.name, sdl: printType(fallback) };
};

type DescribableColumn = {
  name: string;
  dataType: string;
  isNullable: boolean;
  virtual?: boolean;
};

const realColumns = <T extends DescribableColumn>(cols: readonly T[]): T[] =>
  cols.filter((c) => !c.virtual);

const pickGroupByColumn = (cols: readonly DescribableColumn[]): string | null => {
  const real = realColumns(cols);
  if (!real.length) return null;
  const stringNonId = real.find(
    (c) =>
      categorizeSqlType(c.dataType) === SqlTypeCategory.STRING &&
      !c.isNullable &&
      c.name !== "id" &&
      !c.name.endsWith("_id"),
  );
  return (stringNonId ?? real[0]).name;
};

const buildFilterExample = (
  resolverName: string,
  cols: readonly DescribableColumn[],
  sampleFields: readonly string[],
): string | null => {
  const real = realColumns(cols);
  const sub = sampleFields.join("\n    ");
  const stringCol = real.find((c) => categorizeSqlType(c.dataType) === SqlTypeCategory.STRING);
  if (stringCol) {
    return `query {\n  ${resolverName}(where: { ${stringCol.name}: { like: "%search%" } }, limit: 10) {\n    ${sub}\n  }\n}`;
  }
  const numericCol = real.find((c) => isNumericType(c.dataType));
  if (numericCol) {
    return `query {\n  ${resolverName}(where: { ${numericCol.name}: { gt: 0 } }, limit: 10) {\n    ${sub}\n  }\n}`;
  }
  const boolCol = real.find((c) => categorizeSqlType(c.dataType) === SqlTypeCategory.BOOLEAN);
  if (boolCol) {
    return `query {\n  ${resolverName}(where: { ${boolCol.name}: { eq: true } }, limit: 10) {\n    ${sub}\n  }\n}`;
  }
  return null;
};

const buildTableExamples = (
  resolverName: string,
  cols: readonly DescribableColumn[],
): {
  list: string;
  filter: string | null;
  aggregate: string | null;
} | null => {
  const real = realColumns(cols);
  const sampleFields = real.slice(0, 4).map((c) => c.name);
  if (!sampleFields.length) return null;

  const sub = sampleFields.join("\n    ");
  const list = `query {\n  ${resolverName}(limit: 10) {\n    ${sub}\n  }\n}`;

  const filter = buildFilterExample(resolverName, cols, sampleFields);

  const groupCol = pickGroupByColumn(cols);
  let aggregate: string | null = null;
  if (groupCol) {
    const numericCol = real.find((c) => isNumericType(c.dataType));
    const numericAggLines = numericCol
      ? `\n    sum { ${numericCol.name} }\n    avg { ${numericCol.name} }`
      : "";
    const itemFields = sampleFields.slice(0, 3).join(" ");
    aggregate = `query {\n  ${resolverName}_aggregate(groupBy: [${groupCol}]) {\n    key { ${groupCol} }\n    count${numericAggLines}\n    items { ${itemFields} }\n  }\n}`;
  }

  return { list, filter, aggregate };
};

const findRootField = (
  schema: GraphQLSchema,
  name: string,
): {
  rootKind: "Query" | "Mutation" | "Subscription";
  signature: string;
} | null => {
  const roots = [
    ["Query", schema.getQueryType()],
    ["Mutation", schema.getMutationType()],
    ["Subscription", schema.getSubscriptionType()],
  ] as const;
  for (const [rootKind, root] of roots) {
    if (!root) continue;
    const field = root.getFields()[name];
    if (field) {
      const args = field.args.length
        ? `(${field.args.map((a) => `${a.name}: ${a.type.toString()}`).join(", ")})`
        : "";
      return {
        rootKind,
        signature: `${name}${args}: ${field.type.toString()}`,
      };
    }
  }
  return null;
};

// ---- Query validation ----

export type ValidationError = {
  message: string;
  locations?: ReadonlyArray<{ line: number; column: number }>;
};

export type ValidateQueryFn = (query: string) => {
  hasErrors: boolean;
  validationErrors: readonly ValidationError[];
};

/**
 * Build a query validator for a role. Without a positive depth limit it
 * delegates to the role's own `hasErrors`; with one it layers a depth-limit
 * rule on the standard rule set.
 */
export const makeValidateQuery =
  (role: RoleEntities, maxQueryDepth?: number): ValidateQueryFn =>
  (query) => {
    if (maxQueryDepth === undefined || maxQueryDepth <= 0) {
      return role.handlers.gql.hasErrors(query);
    }
    const errors = validate(role.schema, parse(query), [
      ...specifiedRules,
      depthLimitRule(maxQueryDepth),
    ]);
    return { hasErrors: errors.length > 0, validationErrors: errors };
  };

// ---- graphql_execute ----

export type GraphqlExecOutcome =
  | { kind: "non_query" }
  | { kind: "validation"; errors: ValidationError[] }
  | { kind: "ok"; result: unknown }
  | { kind: "error"; message: string };

/**
 * Validate and execute a read-only GraphQL query against a role's handler.
 * Mutations/subscriptions are rejected. Returns a discriminated outcome so
 * callers (MCP, AI agent) shape their own responses.
 */
export const executeGraphqlCore = async (
  role: RoleEntities,
  validateQuery: ValidateQueryFn,
  { query, variables }: { query: string; variables?: Record<string, unknown> },
): Promise<GraphqlExecOutcome> => {
  try {
    if (containsNonQueryOperation(query)) return { kind: "non_query" };

    const { hasErrors, validationErrors } = validateQuery(query);
    if (hasErrors) {
      return {
        kind: "validation",
        errors: validationErrors.map((e) => ({
          message: e.message,
          locations: e.locations,
        })),
      };
    }

    const req = synthesizeRequest("http://graphoria.local/graphql", {
      method: "POST",
    });
    const result = await role.handlers.gql.handler(query, variables ?? {}, req);
    return { kind: "ok", result };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

// ---- list_entities ----

export type EntityListItem = {
  kind: EntityKind;
  name: string;
  summary: string;
  description?: string | null;
};

/**
 * Filter the role's entities by category and/or name fragment.
 * Callers enforce the "at least one of kind/search" guard.
 */
export const listEntitiesCore = (
  role: RoleEntities,
  { kind, search }: { kind?: EntityKind; search?: string },
): EntityListItem[] => {
  const term = search?.toLowerCase();
  const items: EntityListItem[] = [];

  const include = (k: EntityKind) => !kind || kind === k;
  const matchesAny = (...candidates: Array<string | null | undefined>): boolean => {
    if (!term) return true;
    return candidates.some((c) => c != null && c.toLowerCase().includes(term));
  };

  if (include("table")) {
    for (const t of role.tables) {
      if (!matchesAny(t.resolverName, t.schema, t.name, t.tableDescription)) continue;
      items.push({
        kind: "table",
        name: t.resolverName,
        summary: `${t.schema}.${t.name} (${t.columns.length} columns, ${t.relationships.length + t.relationshipsReversed.length} relationships)`,
        description: t.tableDescription ?? null,
      });
    }
  }

  if (include("operation") && role.operations) {
    for (const [name, op] of Object.entries(role.operations)) {
      if (!matchesAny(name, op.description)) continue;
      items.push({
        kind: "operation",
        name,
        summary: op.query ? "GraphQL-query operation" : "Handler operation",
        description: op.description ?? null,
      });
    }
  }

  if (include("remote_schema")) {
    for (const rs of role.remoteSchemas) {
      if (!matchesAny(rs.config.name)) continue;
      items.push({
        kind: "remote_schema",
        name: rs.config.name,
        summary: `prefix=${rs.prefix}, ${rs.queryFields.length} queries, ${rs.mutationFields.length} mutations`,
      });
    }
  }

  if (include("remote_rest")) {
    for (const rr of role.remoteRESTApis) {
      if (!matchesAny(rr.config.name)) continue;
      items.push({
        kind: "remote_rest",
        name: rr.config.name,
        summary: `prefix=${rr.prefix}, ${rr.routes.length} routes`,
      });
    }
  }

  if (include("stored_procedure")) {
    for (const sp of role.storedProcedures) {
      if (!matchesAny(sp.resolverName, sp.schema, sp.name)) continue;
      items.push({
        kind: "stored_procedure",
        name: sp.resolverName,
        summary: `${sp.schema}.${sp.name}`,
      });
    }
  }

  if (include("queue_publisher")) {
    for (const [name, pub] of Object.entries(role.queuesMap)) {
      if (!matchesAny(name, pub.resolverName)) continue;
      items.push({
        kind: "queue_publisher",
        name,
        summary: `publisher → ${pub.resolverName}`,
      });
    }
  }

  return items;
};

// ---- describe_entity ----

/**
 * Describe one entity. When `kind` is given, only that category is looked up
 * (no fallback). Without `kind`, every category is tried, then the raw GraphQL
 * type. Returns `null` when nothing matches.
 */
export const describeEntityCore = (
  role: RoleEntities,
  { name, kind }: { name: string; kind?: EntityKind },
): Record<string, unknown> | null => {
  const schema = role.schema;
  const lookup: Record<EntityKind, () => Record<string, unknown> | null> = {
    table: () => {
      const t = role.tables.find((x) => x.resolverName === name);
      if (!t) return null;
      return {
        kind: "table",
        name: t.resolverName,
        schema: t.schema,
        tableName: t.name,
        description: t.tableDescription ?? null,
        columns: t.columns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.isNullable,
          description: c.description ?? null,
          virtual: "virtual" in c ? c.virtual : false,
        })),
        relationships: t.relationships.map((r) => ({
          to: r.toResolverName,
          columns: r.columns.map((c) => ({ from: c.source, to: c.target })),
        })),
        relationshipsReversed: t.relationshipsReversed.map((r) => ({
          from: r.fromResolverName,
          columns: r.columns.map((c) => ({ from: c.source, to: c.target })),
        })),
        graphqlField: findRootField(schema, name),
        aggregateField: findRootField(schema, `${name}_aggregate`),
        examples: buildTableExamples(t.resolverName, t.columns),
      };
    },
    operation: () => {
      const op = role.operations?.[name];
      if (!op) return null;
      return {
        kind: "operation",
        name,
        description: op.description ?? null,
        hasQuery: Boolean(op.query),
        hasHandler: Boolean(op.handler),
        rest: op.rest ?? null,
        graphql: op.graphql ?? null,
      };
    },
    remote_schema: () => {
      const rs = role.remoteSchemas.find((x) => x.config.name === name);
      if (!rs) return null;
      return {
        kind: "remote_schema",
        name: rs.config.name,
        url: rs.config.url,
        prefix: rs.prefix,
        queryFields: rs.queryFields.map((f) => ({
          name: f.prefixedName,
          sdl: f.sdl,
        })),
        mutationFields: rs.mutationFields.map((f) => ({
          name: f.prefixedName,
          sdl: f.sdl,
        })),
        typeDefsSDL: rs.typeDefsSDL,
      };
    },
    remote_rest: () => {
      const rr = role.remoteRESTApis.find((x) => x.config.name === name);
      if (!rr) return null;
      return {
        kind: "remote_rest",
        name: rr.config.name,
        baseUrl: rr.baseUrl,
        prefix: rr.prefix,
        routes: rr.routes,
        openApiPaths: rr.openApiPaths,
        openApiSchemas: rr.openApiSchemas,
      };
    },
    stored_procedure: () => {
      const sp = role.storedProcedures.find((x) => x.resolverName === name);
      if (!sp) return null;
      return {
        kind: "stored_procedure",
        name: sp.resolverName,
        schema: sp.schema,
        procedureName: sp.name,
        graphqlField: findRootField(schema, name),
      };
    },
    queue_publisher: () => {
      const pub = role.queuesMap[name];
      if (!pub) return null;
      return { kind: "queue_publisher", name, resolverName: pub.resolverName };
    },
  };

  if (kind) return lookup[kind]();

  for (const k of ENTITY_KINDS) {
    const result = lookup[k]();
    if (result) return result;
  }

  const named = schema.getType(name);
  if (named) return describeNamedType(named);

  return null;
};

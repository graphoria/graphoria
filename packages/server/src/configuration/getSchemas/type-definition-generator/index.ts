import type { OpenAPIV3_1 } from "openapi-types";

import { SqlTypeCategory, categorizeSqlType, isNumericType } from "../../../databases/sqlTypeUtils";
import { convertFromZod } from "../../rest/openApiErrors";
import { type MergedEntities } from "../mergeEntities";

// Map JSON Schema type to GraphQL type
export const mapJSONSchemaToGraphQLType = (schema: OpenAPIV3_1.SchemaObject): string => {
  if (!schema) return "String";

  // Handle arrays
  if (schema.type === "array") {
    const itemsSchema = schema.items as OpenAPIV3_1.SchemaObject | undefined;
    const itemType = itemsSchema ? mapJSONSchemaToGraphQLType(itemsSchema) : "String";
    return `[${itemType}]`;
  }

  // Handle basic types
  switch (schema.type) {
    case "integer":
      return "Int";
    case "number":
      return "Float";
    case "boolean":
      return "Boolean";
    case "string":
    default:
      return "String";
  }
};

// Map SQL data types to GraphQL types
export const mapSQLTypeToGraphQLType = (sqlType: string | null): string => {
  if (!sqlType) return "String";

  const category = categorizeSqlType(sqlType);

  switch (category) {
    case SqlTypeCategory.INTEGER:
      return "Int";
    case SqlTypeCategory.FLOAT:
      return "Float";
    case SqlTypeCategory.BOOLEAN:
      return "Boolean";
    case SqlTypeCategory.DATE_TIME:
    case SqlTypeCategory.STRING:
    default:
      return "String";
  }
};

// Map SQL data types to condition types
export const mapSQLTypeToConditionType = (sqlType: string): string => {
  const category = categorizeSqlType(sqlType);

  switch (category) {
    case SqlTypeCategory.INTEGER:
      return "IntCondition";
    case SqlTypeCategory.FLOAT:
      return "FloatCondition";
    case SqlTypeCategory.BOOLEAN:
      return "BooleanCondition";
    case SqlTypeCategory.DATE_TIME:
    case SqlTypeCategory.STRING:
    default:
      return "StringCondition";
  }
};

// Join elements of an array with a newline character
export const lj = <T>(keys: T[], cb?: (value: T) => string) => {
  if (cb) {
    return keys
      .map((i) => cb(i))
      .filter((a) => a.trim())
      .join("\n");
  }

  return keys.filter((a) => (a as string).trim()).join("\n");
};

// Render an SDL block-string description, escaping any embedded triple-quote.
const sdlDesc = (description?: string | null): string =>
  description ? `"""${description.replaceAll('"""', '\\"""')}"""\n` : "";

export const generateTableType = (mergedEntities: MergedEntities) =>
  lj(
    mergedEntities.tables,
    ({ resolverName, columns, relationships, relationshipsReversed, tableDescription }) => `
      ${sdlDesc(tableDescription)}type ${`${resolverName}`} {
        ${lj([
          lj(
            columns,
            ({ name, dataType, isNullable, description }) =>
              `${sdlDesc(description)}${name}: ${mapSQLTypeToGraphQLType(dataType)}${isNullable ? "" : "!"}`,
          ),
          lj(
            relationships,
            ({ toResolverName, toInternalName }) =>
              `${toResolverName}(where: ${toInternalName}WhereInput): ${toInternalName}`,
          ),
          lj(
            relationshipsReversed,
            ({ fromResolverName, fromInternalName }) =>
              `${fromResolverName}(where: ${fromInternalName}WhereInput, orderBy: [${fromInternalName}OrderByInput]): [${fromInternalName}]`,
          ),
        ])}
      }
    `,
  );

export const generateWhereInputType = (mergedEntities: MergedEntities) =>
  lj(
    mergedEntities.tables.map(
      ({ resolverName, columns, relationships, relationshipsReversed }) => `
        input ${resolverName}WhereInput {
          ${lj([
            lj(columns, ({ name, dataType }) => `${name}: ${mapSQLTypeToConditionType(dataType)}`),
            lj(
              relationships,
              ({ toResolverName, toInternalName }) =>
                `${toResolverName}: ${toInternalName}WhereInput`,
            ),
            lj(
              relationshipsReversed,
              ({ fromResolverName, fromInternalName }) =>
                `${fromResolverName}: ${fromInternalName}WhereInput`,
            ),
          ])}
        }
      `,
    ),
  );

// Generate OrderByInput type for each table
export const generateOrderByInputType = (mergedEntities: MergedEntities) =>
  lj(
    mergedEntities.tables.map(
      ({ internalName, columns }) => `
      input ${internalName}OrderByInput {
        ${lj(columns, ({ name }) => `${name}: OrderByEnum`)}
      }`,
    ),
  );

const aggTypes: string[] = ["Min", "Max", "Sum", "Avg"];

// Generate aggregation types for each table
export const generateAggregationTypes = (mergedEntities: MergedEntities) => {
  const aggregationTypes = lj(mergedEntities.tables, ({ resolverName, columns }) => {
    const numericColumns = columns.filter((col) => isNumericType(col.dataType));

    return `
      ${
        numericColumns.length
          ? aggTypes
              .map(
                (agg) =>
                  `
                  type ${resolverName}${agg} {
                    ${lj(numericColumns, ({ name }) => `${name}: ${mapSQLTypeToGraphQLType(columns.find((c) => c.name === name)?.dataType || "")}`)}
                  }
                `,
              )
              .join("\n")
          : ""
      }
      
      type ${resolverName}GroupBy {
        key: ${resolverName}
        count: Int
        ${
          numericColumns.length
            ? aggTypes.map((agg) => `${agg.toLowerCase()}: ${resolverName}${agg}`).join("\n")
            : ""
        }
        items: [${resolverName}]
      }
      
      enum ${resolverName}GroupByKeys {
        ${columns.map((c) => c.name).join("\n")}
      }
      `;
  });

  return aggregationTypes;
};

export const generateAuthTypes = (hasRoles: boolean = false) =>
  hasRoles
    ? `
  type AuthUser {
    id: Int
    username: String
    role: String
  }
  type AuthToken {
    access_token: String
    expires_in: Int
    role: String
  }
  `
    : "";

export const generateQueryType = (mergedEntities: MergedEntities, hasRoles: boolean = false) => {
  const hasRemoteQueries = mergedEntities.remoteSchemas.some((rs) => rs.queryFields.length > 0);

  if (!mergedEntities.tables.length && !hasRoles && !hasRemoteQueries && !mergedEntities.ai)
    return `type Query {
    _no_data: String
  }`;

  return `
    type Query {
      ${lj(
        mergedEntities.tables,
        ({ resolverName }) =>
          `
            ${resolverName}(where: ${resolverName}WhereInput, orderBy: [${resolverName}OrderByInput], limit: Int, offset: Int): [${resolverName}!]!
            ${resolverName}_single(where: ${resolverName}WhereInput): ${resolverName}!
            ${resolverName}_aggregate(where: ${resolverName}WhereInput, orderBy: [${resolverName}OrderByInput], groupBy: [${resolverName}GroupByKeys]!, limit: Int, offset: Int): [${resolverName}GroupBy!]!
          `,
      )}
      ${
        hasRoles
          ? `
              auth_me: AuthUser
            `
          : ""
      }
      ${mergedEntities.ai ? "ask(prompt: String!): String!" : ""}
      ${mergedEntities.remoteSchemas.map((rs) => rs.queryFields.map((f) => f.sdl).join("\n      ")).join("\n      ")}
    }
`;
};

export const generateSubscriptionType = (mergedEntities: MergedEntities) => {
  return `
    ${
      mergedEntities.tables.length || mergedEntities.queues.map((q) => q.queues).flat().length
        ? `
        type QueueMutationResponse {
          id: String!
          message: String!
        }

        type Subscription {
          ${lj(
            mergedEntities.tables,
            ({ resolverName }) =>
              `
                ${resolverName}(where: ${resolverName}WhereInput, orderBy: [${resolverName}OrderByInput], limit: Int, offset: Int): [${resolverName}!]!
                ${resolverName}_single(where: ${resolverName}WhereInput): ${resolverName}!
                ${resolverName}_aggregate(where: ${resolverName}WhereInput, orderBy: [${resolverName}OrderByInput], groupBy: [${resolverName}GroupByKeys], limit: Int, offset: Int): [${resolverName}!]!
              `,
          )}
          ${lj(mergedEntities.queues, (queue) => queue.queues.map((q) => `${queue.name}_${q.name}: QueueMutationResponse!`).join("\n"))}
        }
    `
        : ""
    }`;
};

const generateGraphQLTypeFromSchema = (
  schema: OpenAPIV3_1.SchemaObject,
  typeName: string,
  collector: string[],
): string => {
  if (schema.type === "array") {
    const items = schema.items as OpenAPIV3_1.SchemaObject | undefined;
    if (items?.type === "object" && items.properties) {
      generateGraphQLTypeFromSchema(items, typeName, collector);
      return `[${typeName}]`;
    }
    return `[${mapJSONSchemaToGraphQLType(items ?? {})}]`;
  }

  if (schema.type === "object" && schema.properties) {
    const fields = Object.entries(schema.properties).map(([key, propSchema]) => {
      const prop = propSchema as OpenAPIV3_1.SchemaObject;
      const isRequired = schema.required?.includes(key) ?? false;
      const bang = isRequired ? "!" : "";

      if (prop.type === "object" && prop.properties) {
        const nestedName = `${typeName}${key}`;
        generateGraphQLTypeFromSchema(prop, nestedName, collector);
        return `${key}: ${nestedName}${bang}`;
      }

      if (prop.type === "array") {
        const items = prop.items as OpenAPIV3_1.SchemaObject | undefined;
        if (items?.type === "object" && items.properties) {
          const nestedName = `${typeName}${key}`;
          generateGraphQLTypeFromSchema(items, nestedName, collector);
          return `${key}: [${nestedName}]${bang}`;
        }
        return `${key}: ${mapJSONSchemaToGraphQLType(prop)}${bang}`;
      }

      return `${key}: ${mapJSONSchemaToGraphQLType(prop)}${bang}`;
    });

    collector.push(`type ${typeName} {\n            ${fields.join("\n            ")}\n          }`);
    return typeName;
  }

  return mapJSONSchemaToGraphQLType(schema);
};

export const generateMutationType = (mergedEntities: MergedEntities, hasRoles: boolean = false) => {
  const authQueries = hasRoles
    ? `
      auth_login(username: String, password: String): AuthToken
      auth_refresh: AuthToken
      auth_logout: Boolean
    `
    : "";

  const atLeastOneSP = mergedEntities.storedProcedures.length > 0;

  const publishers = mergedEntities.queues
    .map((q) => q.exchanges.map((e) => e.publishers).flat())
    .flat();

  const atLeastOneQueue = mergedEntities.queues.length > 0 && publishers.length > 0;

  // Filter operations that have GraphQL enabled (default: true)
  const operationsWithMutations = Object.entries(mergedEntities.operations)
    .filter(
      ([, operationConfig]) =>
        operationConfig.graphql.enabled && (operationConfig.rest?.method || "GET") !== "GET",
    )
    .map(([operationName, operationConfig]) => {
      const inputShape = convertFromZod(operationConfig.input);
      const outputShape = convertFromZod(operationConfig.output);

      const hasInputProperties =
        inputShape.type === "object" &&
        inputShape.properties &&
        Object.keys(inputShape.properties).length > 0;

      const hasOutputProperties =
        outputShape.type === "object" &&
        outputShape.properties &&
        Object.keys(outputShape.properties).length > 0;

      const mutationName = operationConfig.graphql?.name ?? operationName;

      const output = hasOutputProperties ? `${mutationName}Output` : "Boolean";

      return {
        input: hasInputProperties
          ? `
          input ${mutationName}Input {
            ${Object.entries(inputShape.properties ?? {})
              .map(
                ([key, value]) =>
                  `${key}: ${mapJSONSchemaToGraphQLType(value as OpenAPIV3_1.SchemaObject)}${inputShape.required?.includes(key) ? "!" : ""}`,
              )
              .join("\n")}
          }
        `
          : "",
        output: (() => {
          if (!hasOutputProperties) return "";
          const collector: string[] = [];
          generateGraphQLTypeFromSchema(outputShape, `${mutationName}Output`, collector);
          return collector.join("\n");
        })(),
        resolver: hasInputProperties
          ? `
          ${mutationName}(input: ${mutationName}Input!): ${output}!
        `
          : `
          ${mutationName}: ${output}!
        `,
      };
    });

  const hasOperations = operationsWithMutations.length > 0;

  const remoteMutationSDLs = mergedEntities.remoteSchemas
    .filter((rs) => rs.mutationFields.length > 0)
    .map((rs) => rs.mutationFields.map((f) => f.sdl).join("\n          "))
    .join("\n          ");

  const hasRemoteMutations = remoteMutationSDLs.length > 0;

  return atLeastOneSP || atLeastOneQueue || authQueries || hasOperations || hasRemoteMutations
    ? `
        ${operationsWithMutations.map((a) => a.input).join("\n")}
        ${operationsWithMutations.map((a) => a.output).join("\n")}

        type Mutation {
          ${lj(mergedEntities.storedProcedures, ({ resolverName, parameters }) => {
            const parametersFiltered = parameters.filter((p) => p.name);

            return `${resolverName}${
              parametersFiltered.length
                ? `(${lj(
                    parametersFiltered,
                    ({ name, dataType }) =>
                      `${name.replaceAll("@", "")}: ${mapSQLTypeToGraphQLType(dataType)}`,
                  )})`
                : ""
            }: Boolean!`;
          })}

          ${lj(publishers, ({ resolverName }) => `${resolverName}(data: String!): Boolean!`)}
          ${operationsWithMutations.map((a) => a.resolver).join("\n")}
          ${authQueries}
          ${remoteMutationSDLs}
        }
`
    : "";
};

const conditionTypes = `
enum OrderByEnum {
  ASC
  DESC
  ASC_NULLS_FIRST
  ASC_NULLS_LAST
  DESC_NULLS_FIRST
  DESC_NULLS_LAST
}

input IntCondition {
  eq: Int
  neq: Int
  gt: Int
  gte: Int
  lt: Int
  lte: Int
  in: [Int]
  between: [Int]
  is_null: Boolean
  not_null: Boolean
}

input FloatCondition {
  eq: Float
  neq: Float
  gt: Float
  gte: Float
  lt: Float
  lte: Float
  in: [Float]
  between: [Float]
  is_null: Boolean
  not_null: Boolean
}

input StringCondition {
  eq: String
  neq: String
  like: String
  in: [String]
  is_null: Boolean
  not_null: Boolean
}

input BooleanCondition {
  eq: Boolean
  neq: Boolean
  is_null: Boolean
  not_null: Boolean
}
`;

const directiveTypes = `
directive @uppercase on FIELD
directive @lowercase on FIELD
directive @truncate(length: Int!) on FIELD
directive @default(value: String!) on FIELD

directive @trim on FIELD
directive @ltrim on FIELD
directive @rtrim on FIELD
directive @substring(start: Int!, length: Int!) on FIELD
directive @replace(find: String!, replaceWith: String!) on FIELD
directive @concat(with: String!, position: String = "after") on FIELD
directive @pad(length: Int!, char: String = " ", side: String = "left") on FIELD

directive @dateFormat(format: String!) on FIELD

directive @round(decimals: Int = 0) on FIELD
directive @ceil on FIELD
directive @floor on FIELD
directive @abs on FIELD
directive @multiply(by: Float!) on FIELD
directive @divide(by: Float!) on FIELD

directive @when(and: [Boolean!], or: [Boolean!]) on FIELD
`;

export const generateTypeDefs = (mergedEntities: MergedEntities, hasAuth: boolean = false) =>
  [
    mergedEntities.tables.length ? conditionTypes : "",
    mergedEntities.tables.length ? directiveTypes : "",
    generateTableType(mergedEntities),
    generateWhereInputType(mergedEntities),
    generateOrderByInputType(mergedEntities),
    generateAggregationTypes(mergedEntities),
    generateAuthTypes(hasAuth),
    // Append remote schema type definitions (prefixed types, inputs, enums)
    ...mergedEntities.remoteSchemas.map((rs) => rs.typeDefsSDL),
    generateQueryType(mergedEntities, hasAuth),
    generateSubscriptionType(mergedEntities),
    generateMutationType(mergedEntities, hasAuth),
  ].join("\n");

import { buildSchema, introspectionFromSchema } from "graphql";

import type { GraphQLSchema } from "graphql";
import type { EntitiesOfRole } from "../../databases/high-level-operations";
import type { Auth } from "../../types/configuration";
import type { HandleGraphQLRequest } from "../gql/handleGraphQLRequestFactory";
import type { MergedEntities } from "./mergeEntities";

import { handleGraphQLRequestFactory } from "../gql/handleGraphQLRequestFactory";
import { handleRESTRequestFactory } from "../rest/handleRESTRequestFactory";
import { mergeEntities } from "./mergeEntities";
import { generateTypeDefs } from "./type-definition-generator";

export const getIntrospectionResult = (schema: GraphQLSchema) => introspectionFromSchema(schema);

export const getGQLEntities = (mergedEntities: MergedEntities, hasAuth: boolean = false) => {
  const typeDefs = generateTypeDefs(mergedEntities, hasAuth);

  const schema = buildSchema(typeDefs);
  const introspection = getIntrospectionResult(schema);

  return { typeDefs, schema, introspection };
};

export type GetGQLEntitiesReturn = ReturnType<typeof getGQLEntities>;

export const getHandlers = (
  entities: MergedEntities,
  gqlEntities: GetGQLEntitiesReturn,
  auth: Auth | null = null,
  gqlSuperadminHandler: HandleGraphQLRequest | null = null,
) => {
  const gql = handleGraphQLRequestFactory(entities, gqlEntities, auth);

  return {
    gql,
    rest: handleRESTRequestFactory(entities, gqlEntities, gql, auth, gqlSuperadminHandler),
  };
};

export type GetInformationAndHandlerReturn = Awaited<ReturnType<typeof getHandlers>>;

export const getSchema = (
  entityOfRole: EntitiesOfRole,
  auth: Auth | null = null,
  gqlSuperadminHandler: HandleGraphQLRequest | null = null,
  includeAI: boolean = false,
) => {
  const entities = mergeEntities(entityOfRole, auth?.enabled ?? false, includeAI);

  const gqlEntities = getGQLEntities(entities, auth?.enabled);

  return {
    ...entities,
    ...gqlEntities,
    handlers: getHandlers(entities, gqlEntities, auth, gqlSuperadminHandler),
  };
};

export type GetSchemaReturn = ReturnType<typeof getSchema>;

export const getSchemas = (
  tablesAndStoredProceduresForRole: Record<string, EntitiesOfRole>,
  auth: Auth,
  gqlSuperadminHandler: HandleGraphQLRequest,
) => {
  const schemas: Record<
    string,
    MergedEntities &
      GetGQLEntitiesReturn & {
        handlers: GetInformationAndHandlerReturn;
      }
  > = {};

  for (const [role, entitiesOfRole] of Object.entries(tablesAndStoredProceduresForRole)) {
    schemas[role] = getSchema(entitiesOfRole, auth, gqlSuperadminHandler);
  }

  return schemas;
};

export type GetSchemasReturn = Awaited<ReturnType<typeof getSchemas>>;

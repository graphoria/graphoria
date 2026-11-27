import { buildSchema, introspectionFromSchema } from "graphql";

import type { IntrospectionQuery } from "graphql";
import type { EntitiesWithSchema } from "../../analyzeQuery/types";
import type { EntitiesOfRole } from "../../databases/high-level-operations";
import type { Auth } from "../../types/configuration";
import type { HandleGraphQLRequest } from "../gql/handleGraphQLRequestFactory";
import type { HandleRESTRequest } from "../rest/handleRESTRequestFactory";
import type { MergedEntities } from "./mergeEntities";

import { handleGraphQLRequestFactory } from "../gql/handleGraphQLRequestFactory";
import { handleRESTRequestFactory } from "../rest/handleRESTRequestFactory";
import { mergeEntities } from "./mergeEntities";
import { generateTypeDefs } from "./type-definition-generator";

export type SchemaEntities = EntitiesWithSchema & {
  typeDefs: string;
  introspection: IntrospectionQuery;
};

const getGQLEntities = (mergedEntities: MergedEntities, hasAuth: boolean = false) => {
  const typeDefs = generateTypeDefs(mergedEntities, hasAuth);
  const schema = buildSchema(typeDefs);

  return { typeDefs, schema, introspection: introspectionFromSchema(schema) };
};

export const getSchema = (
  entityOfRole: EntitiesOfRole,
  auth: Auth | null = null,
  gqlSuperadminHandler: HandleGraphQLRequest | null = null,
  includeAI: boolean = false,
) => {
  const mergedEntities = mergeEntities(entityOfRole, auth?.enabled ?? false, includeAI);

  const entities: SchemaEntities = {
    ...mergedEntities,
    ...getGQLEntities(mergedEntities, auth?.enabled),
  };

  // An operation field runs as its REST route does, which needs the REST
  // factory, which needs the GraphQL one: the route is read per request.
  let rest: HandleRESTRequest | undefined;
  const gql = handleGraphQLRequestFactory(entities, auth, () => rest!);
  rest = handleRESTRequestFactory(entities, gql, auth, gqlSuperadminHandler);

  return {
    ...entities,
    handlers: { gql, rest },
  };
};

export type GetSchemaReturn = ReturnType<typeof getSchema>;

export const getSchemas = (
  tablesAndStoredProceduresForRole: Record<string, EntitiesOfRole>,
  auth: Auth,
  gqlSuperadminHandler: HandleGraphQLRequest,
  askEnabled: boolean = false,
) => {
  const schemas: Record<string, GetSchemaReturn> = {};

  for (const [role, entitiesOfRole] of Object.entries(tablesAndStoredProceduresForRole)) {
    schemas[role] = getSchema(
      entitiesOfRole,
      auth,
      gqlSuperadminHandler,
      askEnabled && entitiesOfRole.ai === true,
    );
  }

  return schemas;
};

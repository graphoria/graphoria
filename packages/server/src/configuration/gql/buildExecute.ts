import type { SessionContext } from "../../utils/sessionVariables";
import type { HandleGraphQLRequest } from "./handleGraphQLRequestFactory";

export type ExecuteOptions = {
  role?: string;
  session?: SessionContext;
};

type RolesWithGqlHandler = Record<string, { handlers: { gql: HandleGraphQLRequest } }>;

/**
 * Wrap the per-role GraphQL handlers in a single `execute(query, variables, opts)`
 * function — the same orchestration the `/graphql` POST route performs (introspection
 * / no-data short-circuits, validation, dispatch) minus the HTTP layer. Lets callers
 * run a query in-process without standing up a server.
 *
 * @param roles - The analyzed-configuration role map (`analyzedConfiguration.roles`).
 * @param defaultRole - Role used when `opts.role` is omitted (the server passes its
 *   superadmin role, so in-process execution runs with full privileges).
 */
export const buildExecute = (roles: RolesWithGqlHandler, defaultRole: string) => {
  return async (
    query: string,
    variables: Record<string, unknown> = {},
    opts: ExecuteOptions = {},
  ) => {
    const role = opts.role ?? defaultRole;
    const roleSchema = roles[role];

    if (!roleSchema) {
      throw new Error(`Unknown role: ${role}`);
    }

    const { gql } = roleSchema.handlers;

    if (gql.isIntrospectionQuery(query)) return gql.introspectionResult;
    if (gql.isNoDataQuery(query)) return gql.noDataResult;

    const { hasErrors, validationErrors } = gql.hasErrors(query);

    if (hasErrors) {
      return {
        errors: validationErrors.map((error) => ({
          message: error.message,
          locations: error.locations,
        })),
      };
    }

    // No BunRequest in-process: request-dependent features (operation `init`/
    // `beforeRequest` hooks, header-derived session variables) won't run.
    return gql.handler(query, variables, undefined, opts.session);
  };
};

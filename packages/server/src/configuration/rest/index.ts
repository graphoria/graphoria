import { match } from "path-to-regexp";
import z from "zod";

import type { MatchFunction } from "path-to-regexp";
import type { AnalysisResult } from "../../analyzeQuery/types";
import type { SchemaEntities } from "../../configuration/getSchemas";
import type { Auth, Operations } from "../../types/configuration";
import type { HandleGraphQLRequest } from "../gql/handleGraphQLRequestFactory";

import { analyzeQuery } from "../../analyzeQuery";
import { buildCacheStore, registerCache } from "../../singletons/cache";

export type AuthOperation = "login" | "logout" | "refresh" | "me";

export type OperationsEnhanced = {
  [K in keyof Operations]: Operations[K] & {
    queryStructure: AnalysisResult | null;
    testPath: MatchFunction<Partial<Record<string, string | string[]>>>;
    hasError: boolean;
    routeKey: K;
    authOperation?: AuthOperation;
  };
};

export const buildApiRoutes = (
  entities: SchemaEntities,
  gql: HandleGraphQLRequest,
  auth: Auth | null = null,
  gqlSuperadminHandler: HandleGraphQLRequest | null = null,
) => {
  const operationsEnhanced: OperationsEnhanced = {};

  for (const [routeKey, routeConfig] of Object.entries(entities.operations)) {
    // Skip validation for custom handler endpoints (they don't have a query)
    let queryStructure: AnalysisResult | null = null;
    let hasError = false;

    if (routeConfig.query) {
      // Operation queries come from the configuration, not from a caller, so the
      // depth and cost limits do not apply to them — they would turn an
      // operator's own deep or wide query into a dead route.
      const validationErrors = gql.hasErrors(routeConfig.query, {
        enforceDepthLimit: false,
        enforceCostLimit: false,
      });

      if (validationErrors.hasErrors && gqlSuperadminHandler) {
        // Re-validate with superadmin handler if available
        const superadminErrors = gqlSuperadminHandler.hasErrors(routeConfig.query, {
          enforceDepthLimit: false,
          enforceCostLimit: false,
        });

        if (superadminErrors.hasErrors) {
          throw new Error(`Endpoint ${routeKey} has invalid query.`);
        }
      }

      hasError = validationErrors.hasErrors;

      queryStructure = analyzeQuery(routeConfig.query, entities);
    }

    const testPath = match(routeConfig.rest!.path);

    if (routeConfig.cache) {
      registerCache(routeKey, buildCacheStore(routeKey, routeConfig.cache));
    }

    operationsEnhanced[routeKey] = {
      ...routeConfig,
      queryStructure,
      testPath,
      hasError,
      routeKey,
    };
  }

  if (auth?.enabled) {
    operationsEnhanced["login"] = {
      graphql: { enabled: false },
      hasError: false,
      routeKey: "login",
      testPath: match("/auth/login"),
      queryStructure: null,
      authOperation: "login",
      description: "Authentication check endpoint",
      rest: {
        path: "/auth/login",
        method: "POST",
        body: z.object({
          username: z.string().min(1),
          password: z.string().min(1),
        }),
      },
      output: z.object({
        access_token: z.string(),
        expires_in: z.number(),
        role: z.string(),
      }),
    };

    operationsEnhanced["logout"] = {
      graphql: { enabled: false },
      hasError: false,
      routeKey: "logout",
      testPath: match("/auth/logout"),
      queryStructure: null,
      authOperation: "logout",
      description: "Logout endpoint",
      rest: { path: "/auth/logout", method: "POST" },
      output: z.boolean(),
    };

    operationsEnhanced["refresh"] = {
      graphql: { enabled: false },
      hasError: false,
      routeKey: "refresh",
      testPath: match("/auth/refresh"),
      queryStructure: null,
      authOperation: "refresh",
      description: "Refresh endpoint",
      rest: { path: "/auth/refresh", method: "POST" },
      output: z.object({
        access_token: z.string(),
        expires_in: z.number(),
        role: z.string(),
      }),
    };

    operationsEnhanced["me"] = {
      graphql: { enabled: false },
      hasError: false,
      routeKey: "me",
      testPath: match("/auth/me"),
      queryStructure: null,
      authOperation: "me",
      description: "Me endpoint",
      rest: { path: "/auth/me", method: "GET" },
      output: z.object({
        username: z.string(),
        role: z.string(),
      }),
    };
  }

  return {
    operationsEnhanced,
  };
};

import { match } from "path-to-regexp";
import z from "zod";

import type { LRUCache } from "lru-cache";
import type { MatchFunction } from "path-to-regexp";
import type { AnalysisResult } from "../../analyzeQuery/types";
import type { GetGQLEntitiesReturn } from "../../configuration/getSchemas";
import type { Auth, Operations } from "../../types/configuration";
import type { MergedEntities } from "../getSchemas/mergeEntities";
import type { HandleGraphQLRequest } from "../gql/handleGraphQLRequestFactory";

import { analyzeQuery } from "../../analyzeQuery";
import { LruCacheStore, RedisCacheStore, registerCache } from "../../singletons/cache";
import { env } from "../../singletons/env";

type LruOptions = LRUCache.Options<string, unknown, unknown>;

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
  entities: MergedEntities,
  gqlEntities: GetGQLEntitiesReturn,
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
      const validationErrors = gql.hasErrors(routeConfig.query);

      if (validationErrors.hasErrors && gqlSuperadminHandler) {
        // Re-validate with superadmin handler if available
        const superadminErrors = gqlSuperadminHandler.hasErrors(routeConfig.query);

        if (superadminErrors.hasErrors) {
          throw new Error(`Endpoint ${routeKey} has invalid query.`);
        }
      }

      hasError = validationErrors.hasErrors;

      queryStructure = analyzeQuery(routeConfig.query, entities, gqlEntities.schema);
    }

    const testPath = match(routeConfig.rest!.path);

    if (routeConfig.cache) {
      if (env.cache.store === "redis") {
        registerCache(routeKey, new RedisCacheStore(routeKey, routeConfig.cache.ttl));
      } else {
        const cacheOptions: Partial<LruOptions> = {};

        if (routeConfig.cache.max) cacheOptions.max = routeConfig.cache.max;
        if (routeConfig.cache.maxSize) cacheOptions.maxSize = routeConfig.cache.maxSize;
        if (routeConfig.cache.ttl) cacheOptions.ttl = routeConfig.cache.ttl;
        if (routeConfig.cache.allowStale !== undefined)
          cacheOptions.allowStale = routeConfig.cache.allowStale;
        if (routeConfig.cache.updateAgeOnGet !== undefined)
          cacheOptions.updateAgeOnGet = routeConfig.cache.updateAgeOnGet;
        if (routeConfig.cache.updateAgeOnHas !== undefined)
          cacheOptions.updateAgeOnHas = routeConfig.cache.updateAgeOnHas;
        if (routeConfig.cache.ttlAutopurge !== undefined)
          cacheOptions.ttlAutopurge = routeConfig.cache.ttlAutopurge;

        // LRUCache.Options requires at least one of max/maxSize/ttl. Caller is
        // responsible for setting one; the cast bridges the structural gap.
        registerCache(routeKey, new LruCacheStore(cacheOptions as LruOptions));
      }
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

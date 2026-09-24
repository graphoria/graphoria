import { z } from "zod";

import { TokenStrategyZod } from "../../config";
import { AIZod } from "./ai";
import { AuthZod } from "./auth";
import { TypedCronJobZod } from "./cron";
import { DatabaseConnectionZod } from "./db";
import { OperationsZod } from "./operation";
import { QueueConfigZod } from "./queue";
import { RemoteRESTConfigZod } from "./remoteREST";
import { RemoteSchemaConfigZod } from "./remoteSchema";

export const ConfigurationZod = z
  .strictObject({
    /** Project name */
    name: z.string(),
    /** Project version */
    version: z.string(),
    /**
     * Token strategy: "jwt" (default), "paseto_local", or "paseto_public"
     *
     * When using PASETO, set the corresponding environment variables:
     * - paseto_local: PASETO_LOCAL_KEY (k4.local.xxx format)
     * - paseto_public: PASETO_SECRET_KEY (k4.secret.xxx) + PASETO_PUBLIC_KEY (k4.public.xxx)
     */
    tokenStrategy: TokenStrategyZod.optional().default("jwt"),
    /** Database connections */
    databases: z.array(DatabaseConnectionZod).default([]),
    /** Message queues (RabbitMQ, Kafka) */
    queues: z.array(QueueConfigZod).optional().default([]),
    /** Cron jobs */
    cron: z.array(TypedCronJobZod).optional().default([]),
    /** Operations - unified handlers for REST + GraphQL */
    operations: OperationsZod.optional().default({}),
    /** Authentication configuration */
    auth: AuthZod,
    /** Remote GraphQL schemas to merge into the API */
    remoteSchemas: z.array(RemoteSchemaConfigZod).optional().default([]),
    /** Remote REST APIs (OpenAPI) to proxy under /rest */
    remoteREST: z.array(RemoteRESTConfigZod).optional().default([]),
    /** AI agent (admin-only NL → database Q&A) + MCP server. Off by default. */
    ai: AIZod.optional().default({ enabled: false, endpoint: "/ai", mcp: { enabled: false } }),
  })
  .refine(
    (data) => {
      if (!data.auth?.enabled) return true;

      return data.auth?.enabled && data.databases.find((db) => db.name === data.auth?.database);
    },
    {
      message: "Database to store auth information is not found",
      path: ["auth", "database"],
    },
  )
  .transform((data) => ({
    ...data,
    // Pre-calculate enabled databases during parsing
    enabledDatabases: data.databases.filter((d) => d.enabled),
    auth: {
      ...data.auth!,
      databaseEntity: data.databases.find((db) => db.name === data.auth!.database)!,
    },
  }));

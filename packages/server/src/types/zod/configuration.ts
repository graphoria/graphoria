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
  .object({
    name: z.string(),
    version: z.string(),
    tokenStrategy: TokenStrategyZod.optional().default("jwt"),
    databases: z.array(DatabaseConnectionZod).default([]),
    queues: z.array(QueueConfigZod).optional().default([]),
    cron: z.array(TypedCronJobZod).optional().default([]),
    operations: OperationsZod.optional().default({}),
    auth: AuthZod,
    remoteSchemas: z.array(RemoteSchemaConfigZod).optional().default([]),
    remoteREST: z.array(RemoteRESTConfigZod).optional().default([]),
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

import { z } from "zod";

import { version } from "../../package.json";
import { ConfigurationZod } from "./zod/configuration";

export const EnvZod = z
  .object({
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.string().default("DEVELOPMENT"),
    ADMIN_SECRET: z.string(),
    CONFIGURATION: z.union([z.string(), ConfigurationZod]).optional(),
    ANONYMOUS_ROLE: z.string().default("anonymous"),
    JWT_SECRET: z.string().optional().default(""),
    JWT_EXPIRES_IN: z.string().default("5m"),
    JWT_RT_EXPIRES_IN: z.string().default("7d"),
    PASETO_LOCAL_KEY: z.string().optional().default(""),
    PASETO_SECRET_KEY: z.string().optional().default(""),
    PASETO_PUBLIC_KEY: z.string().optional().default(""),
    AUTH_STRATEGY: z.enum(["jwt", "paseto_local", "paseto_public"]).optional(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    CACHE_STORE: z.enum(["memory", "redis"]).default("memory"),
    REST_API_PREFIX: z.string().default("/rest"),
    GRAPHQL_API_ENDPOINT: z.string().default("/graphql"),
    ADMIN_SECRET_HEADER: z.string().default("x-admin-secret"),
    AUTHORIZATION_HEADER: z.string().default("authorization"),
    GRAPHIQL_ENDPOINT: z.string().default("/graphiql"),
    SCALAR_ENDPOINT: z.string().default("/scalar"),
    OPENAPI_ENDPOINT: z.string().default("/openapi.json"),
    SUPERADMIN_ROLE: z.string().default("superadmin"),
    // Boolean flags use stringbool, not coerce.boolean: Boolean("false") === true would flip them on
    CONSOLE_ENABLED: z.stringbool().default(false),
    CONSOLE_ENDPOINT: z.string().default("/_console"),
    PREFIX: z.string().default(""),
    CORS_ENABLED: z.stringbool().default(true),
    PRINT_SCHEMAS: z.stringbool().default(false),
    SCHEMAS_OUTPUT_DIR: z.string().default("./.graphoria/schemas"),
    QUERY_ON_RESPONSE: z.stringbool().default(false),
    MAX_QUERY_DEPTH: z.coerce.number().int().min(0).default(0),
    AI_ENABLED: z.stringbool().optional(),
    AI_GRAPHQL_ENABLED: z.stringbool().default(true),
    AI_REST_ENABLED: z.stringbool().default(true),
    AI_MCP_ENABLED: z.stringbool().optional(),
    AI_MCP_ENDPOINT: z.string().default("/mcp"),
    AI_MCP_REQUIRE_ADMIN_SECRET: z.stringbool().default(false),
    AI_MCP_MAX_QUERY_DEPTH: z.coerce.number().int().min(0).optional(),
    AI_MCP_DISABLED_TOOLS: z.string().default(""),
    AI_MCP_DISABLED_RESOURCES: z.string().default(""),
    AI_MCP_DISABLED_PROMPTS: z.string().default(""),
    AI_SYSTEM_PROMPT: z.string().optional(),
    AI_PROMPT_TEMPLATE: z.string().optional(),
  })
  .transform((env) => ({
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    version,
    configuration: env.CONFIGURATION,
    prefix: env.PREFIX,
    enableCors: env.CORS_ENABLED,
    restApiPrefix: env.REST_API_PREFIX,
    graphqlApiEndpoint: env.GRAPHQL_API_ENDPOINT,
    graphiqlEndpoint: env.GRAPHIQL_ENDPOINT,
    scalarEndpoint: env.SCALAR_ENDPOINT,
    openApiEndpoint: env.OPENAPI_ENDPOINT,
    authorizationHeader: env.AUTHORIZATION_HEADER,
    anonymousRole: env.ANONYMOUS_ROLE,
    authStrategy: env.AUTH_STRATEGY,
    queryOnResponse: env.QUERY_ON_RESPONSE,
    maxQueryDepth: env.MAX_QUERY_DEPTH,
    admin: {
      secret: env.ADMIN_SECRET,
      header: env.ADMIN_SECRET_HEADER,
    },
    jwt: {
      secret: env.JWT_SECRET,
      expiresIn: env.JWT_EXPIRES_IN,
      rtExpiresIn: env.JWT_RT_EXPIRES_IN,
    },
    paseto: {
      localKey: env.PASETO_LOCAL_KEY,
      secretKey: env.PASETO_SECRET_KEY,
      publicKey: env.PASETO_PUBLIC_KEY,
    },
    cache: {
      store: env.CACHE_STORE,
      redisUrl: env.REDIS_URL,
    },
    schemas: {
      print: env.PRINT_SCHEMAS,
      outputDir: env.SCHEMAS_OUTPUT_DIR,
    },
    superadmin: {
      role: env.SUPERADMIN_ROLE,
    },
    console: {
      enabled: env.CONSOLE_ENABLED,
      endpoint: env.CONSOLE_ENDPOINT,
    },
    ai: {
      enabled: env.AI_ENABLED,
      graphqlEnabled: env.AI_GRAPHQL_ENABLED,
      restEnabled: env.AI_REST_ENABLED,
      mcp: {
        enabled: env.AI_MCP_ENABLED,
        endpoint: env.AI_MCP_ENDPOINT,
        requireAdminSecret: env.AI_MCP_REQUIRE_ADMIN_SECRET,
        maxQueryDepth: env.AI_MCP_MAX_QUERY_DEPTH,
        disabledTools: env.AI_MCP_DISABLED_TOOLS
          ? env.AI_MCP_DISABLED_TOOLS.split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        disabledResources: env.AI_MCP_DISABLED_RESOURCES
          ? env.AI_MCP_DISABLED_RESOURCES.split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        disabledPrompts: env.AI_MCP_DISABLED_PROMPTS
          ? env.AI_MCP_DISABLED_PROMPTS.split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      },
      systemPrompt: env.AI_SYSTEM_PROMPT,
      promptTemplate: env.AI_PROMPT_TEMPLATE,
    },
  }));

export type EnvInput = z.input<typeof EnvZod>;
export type Env = z.infer<typeof EnvZod> & {
  logger?: import("pino").Logger | import("pino").LoggerOptions;
};

declare module "bun" {
  interface Env extends EnvInput {
    VERSION?: string;
  }
}

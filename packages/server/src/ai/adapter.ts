import type { BunRequest } from "bun";
import type { OpenAPIV3_1 } from "openapi-types";

import type { Capability } from "../authentication/capabilities";
import type { GetSchemaReturn, SchemaEntities } from "../configuration/getSchemas";
import type { ConsumeResult } from "../utils/rateLimit";
import type { SessionContext } from "../utils/sessionVariables";

import { checkQueryCost } from "../analyzeQuery/costLimit";
import { depthLimitRule } from "../analyzeQuery/depthLimit";
import { categorizeSqlType, isNumericType } from "../databases/sqlTypeUtils";
import { columnFieldName } from "../databases/transformers/graphqlName";
import { logger } from "../logging";

export type { GetSchemaReturn } from "../configuration/getSchemas";

export type ValidationError = {
  message: string;
  locations?: ReadonlyArray<{ line: number; column: number }>;
};

export type RoleGraphQL = {
  hasErrors: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => { hasErrors: boolean; validationErrors: readonly ValidationError[] };
  handler: (
    query: string,
    variables?: Record<string, unknown>,
    req?: BunRequest,
    session?: SessionContext,
  ) => Promise<unknown>;
};

export type RoleEntities = SchemaEntities & { handlers: { gql: RoleGraphQL } };

export type ToolCaller = { session?: SessionContext; req?: BunRequest };

export type AgentCaller = { role: RoleEntities; session?: SessionContext; req?: BunRequest };

export type Agent = (prompt: string, caller: AgentCaller) => Promise<string>;

export type AiToolDeps = {
  logger: typeof logger;
  checkQueryCost: typeof checkQueryCost;
  depthLimitRule: typeof depthLimitRule;
  categorizeSqlType: typeof categorizeSqlType;
  isNumericType: typeof isNumericType;
  columnFieldName: typeof columnFieldName;
  maxQueryCost: number;
  defaultPageSize: number;
  maxPageSize: number;
  rateLimited: (retryAfterMs: number) => Response;
};

export type ToolFunction = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type ToolDefinition = { type: "function"; function: ToolFunction };

export type ToolCall = {
  id: string;
  function: { name: string; arguments: Record<string, unknown> };
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
};

export type ChatResult = { content: string; toolCalls: ToolCall[] };

export type Provider = {
  chat(messages: Message[], tools: ToolDefinition[], signal?: AbortSignal): Promise<ChatResult>;
};

export type McpCaller = {
  role: string;
  session: SessionContext;
  scope?: Capability | "all";
  limit?: ConsumeResult;
};

export type CreateMCPRoutesOptions = {
  name?: string;
  version?: string;
  maxQueryDepth?: number;
  disabledTools?: string[];
  disabledResources?: string[];
  disabledPrompts?: string[];
  requireAdminSecret?: boolean;
  resolveCaller: (req: Request, server?: Bun.Server<unknown>) => Promise<McpCaller>;
  openapiFor: (role: string) => OpenAPIV3_1.Document;
};

export type AiPackage = {
  defaults: { systemPrompt: string; promptTemplate: string };
  createAgent: (
    deps: AiToolDeps,
    settings: { systemPrompt: string; promptTemplate: string; timeoutMs: number },
  ) => Agent;
  createMCPRoutes: (
    deps: AiToolDeps,
    roles: Record<string, GetSchemaReturn>,
    options: CreateMCPRoutesOptions,
  ) => {
    POST: (req: Request, server?: Bun.Server<unknown>) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
    DELETE: (req: Request) => Promise<Response>;
  };
  setProvider: (provider: Provider | null) => void;
};

import type { Agent, AiPackage, AiToolDeps } from "../ai/adapter";
import type { Env } from "../types/env";
import type { AIConfig } from "../types/zod/ai";

import { checkQueryCost } from "../analyzeQuery/costLimit";
import { depthLimitRule } from "../analyzeQuery/depthLimit";
import { scopedCredentialRole } from "../authentication/capabilities";
import { categorizeSqlType, isNumericType } from "../databases/sqlTypeUtils";
import { columnFieldName } from "../databases/transformers/graphqlName";
import { logger } from "../logging";
import { S429 } from "../utils/responses";
import { env } from "./env";

type AgentSettings = { agent: Agent };

let settings: AgentSettings | null = null;

// Not a literal: TypeScript would follow the import into the package, whose
// @graphoria/server types resolve to this package's own dist (TS5055 on build).
const AI_PACKAGE = "@graphoria/ai";

// Resolving first tells a missing package apart from one that fails to load: a
// load error (a broken install, a missing dependency of the package) surfaces as is.
export const importAiPackage = async (): Promise<AiPackage | undefined> => {
  try {
    import.meta.resolve(AI_PACKAGE);
  } catch {
    return undefined;
  }
  return (await import(AI_PACKAGE)) as AiPackage;
};

/** The runtime the package's tools need, assembled from the server's own pieces. */
export const makeAiToolDeps = (env: Env): AiToolDeps => ({
  logger,
  checkQueryCost,
  depthLimitRule,
  categorizeSqlType,
  isNumericType,
  columnFieldName,
  maxQueryCost: env.maxQueryCost,
  defaultPageSize: env.defaultPageSize,
  maxPageSize: env.maxPageSize,
  rateLimited: (retryAfterMs) => new S429(retryAfterMs),
});

export type AiDependencies = {
  /** Test seam: discovery loads the package through this; `undefined` when it is not installed. */
  importAi?: () => Promise<AiPackage | undefined>;
};

/**
 * Store the agent's prompts and its LLM call timeout. Called at boot when the agent is on.
 *
 * Precedence for systemPrompt / promptTemplate:
 *   1. Env-var override (`AI_SYSTEM_PROMPT` / `AI_PROMPT_TEMPLATE`)
 *   2. Config-file value (`ai.systemPrompt`)
 *   3. The package's built-in default
 */
export const instantiateAI = async (
  aiConfig: AIConfig,
  envOverrides?: { systemPrompt?: string; promptTemplate?: string; timeoutMs?: number },
  { importAi = importAiPackage }: AiDependencies = {},
): Promise<void> => {
  const mod = await importAi();
  if (!mod) throw new Error("ai.enabled requires @graphoria/ai (add it to dependencies)");

  settings = {
    agent: mod.createAgent(makeAiToolDeps(env), {
      systemPrompt:
        envOverrides?.systemPrompt ?? aiConfig.systemPrompt ?? mod.defaults.systemPrompt,
      promptTemplate: envOverrides?.promptTemplate ?? mod.defaults.promptTemplate,
      timeoutMs: envOverrides?.timeoutMs ?? 0,
    }),
  };
};

/**
 * The tools are built for each call rather than once at boot, so every caller
 * reads through its own role, session and request — what its own queries see.
 */
export const getAgent = (): Agent => {
  if (!settings) {
    throw new Error("AI agent is not enabled. Set `ai.enabled = true` in your configuration.");
  }
  return settings.agent;
};

/** Test-only reset. */
export const resetAI = (): void => {
  settings = null;
};

export type AISurfaces = { agent: boolean; ask: boolean; rest: boolean; mcp: boolean };

/**
 * What this boot mounts. Each env var wins over its config field when set. MCP
 * stands apart from the agent: it calls no LLM, so it needs no `ai.enabled`.
 */
export const resolveAISurfaces = (env: Env, ai: AIConfig | undefined): AISurfaces => {
  const agent = env.ai?.enabled ?? ai?.enabled ?? false;

  return {
    agent,
    ask: agent && (env.ai?.graphqlEnabled ?? true),
    rest: agent && (env.ai?.restEnabled ?? true),
    mcp: env.ai?.mcp?.enabled ?? ai?.mcp?.enabled ?? false,
  };
};

/**
 * A scoped credential naming a role the configuration does not define — or,
 * for the agent, one not granted `ai` — would open nothing. Refuse to boot
 * instead, but only for a credential someone can present on a mounted route.
 */
export const assertScopedRoles = (
  env: Env,
  roles: Record<string, { entityOfRole: { ai?: boolean } }>,
  surfaces: AISurfaces,
): void => {
  const check = (variable: string, role: string, needsAi: boolean) => {
    const granted = Object.hasOwn(roles, role) ? roles[role] : undefined;
    if (!granted) throw new Error(`${variable} is "${role}", which is not a configured role`);
    if (needsAi && !granted.entityOfRole.ai) {
      throw new Error(
        `${variable} is "${role}", which is not granted the AI agent (permissions.${role}.ai)`,
      );
    }
  };

  if (surfaces.rest && (env.ai?.secrets?.length ?? 0) > 0) {
    check("AI_SECRET_ROLE", scopedCredentialRole(env, "ai"), true);
  }
  if (surfaces.mcp && (env.ai?.mcp?.secrets?.length ?? 0) > 0) {
    check("AI_MCP_SECRET_ROLE", scopedCredentialRole(env, "mcp"), false);
  }
};

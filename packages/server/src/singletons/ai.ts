import type { BunRequest } from "bun";
import type { Env } from "../types/env";
import type { AIConfig } from "../types/zod/ai";
import type { SessionContext } from "../utils/sessionVariables";

import { ask, buildAgentTools, type RoleEntities } from "../ai";
import { scopedCredentialRole } from "../authentication/capabilities";

/**
 * Default system prompt: pins the agent to the list → describe → execute
 * workflow and forbids fabrication. Overridable via `ai.systemPrompt`.
 */
export const DEFAULT_AI_SYSTEM_PROMPT = `You are a database assistant for a Graphoria GraphQL API. Answer the user's question using ONLY the provided tools. Never fabricate, invent, or guess data.

Required workflow (STOP after step 3 — present results immediately):
1. list_entities — find relevant tables (REQUIRES \`kind\` or \`search\`; search matches names AND descriptions, so try natural-language keywords).
2. describe_entity — read the table's columns, the aggregateField signature, and the pre-built \`examples\` (list / filter / aggregate). Prefer copying an example over composing a query from scratch.
3. query_data — run ONE query (pick aggregate OR list, not both). Then STOP and present the answer.

For counts, totals, grouping, breakdowns, or summaries: use query_data with operation "aggregate" and groupBy. Never fetch all rows and count client-side.

Aggregate shape (\`key\` is an object and must be sub-selected):

  query {
    <entity>_aggregate(groupBy: [<col>]) {
      key { <col> }
      count
      items { <fields> }
    }
  }

CRITICAL: After query_data returns data, present the answer IMMEDIATELY. Do NOT call more tools. Do NOT re-query with a different operation. One query → present results → done. Use a Markdown table for grouped results.`;

export const DEFAULT_AI_PROMPT_TEMPLATE = `Database-query request from the user:

> {prompt}

You MUST follow this EXACT workflow — do NOT skip steps, do NOT answer before completing all steps:

STEP 1 — list_entities: Call with \`kind\` and/or \`search\` to find relevant tables. The result includes a \`name\` field (e.g. "pg_public_contacts"). MEMORIZE the \`tableName\` field (e.g. "contacts") — you will need it for step 3.

STEP 2 — describe_entity: Call using the EXACT \`name\` string from step 1 (do NOT shorten, transform, or guess it — "pg_public_contacts" is NOT "contacts"). The result contains the table's columns — copy the column names EXACTLY for step 3.

STEP 3 — query_data: Send a structured JSON query. Pick ONE operation — aggregate (for grouping/counts) OR list (for row data). Do NOT call both. The entity must be the EXACT resolverName from step 1 (e.g. "pg_public_contacts"). For aggregates, use operation "aggregate" with groupBy. ALWAYS include \`"filters": { "deleted_at": { "is_null": true } }\` unless the user asks for deleted data.

STEP 4 — STOP AND PRESENT: After query_data returns, present the answer IMMEDIATELY. Do NOT call more tools. Do NOT re-query. Format grouped results as a Markdown table. You are DONE after this step.

CRITICAL RULES:
- NEVER fabricate, invent, or guess query results. ONLY report data returned by query_data.
- After getting data, STOP. Do not query again. One query_data call is enough.
- Copy column names EXACTLY from describe_entity — do not guess or invent field names.
- For aggregates: set \`"operation": "aggregate"\`, provide \`"groupBy"\` as an array of column names.
- For lists: set \`"operation": "list"\`, provide \`"columns"\` as an array of column names.
- The \`entity\` field is the EXACT resolverName from step 1 (e.g. "pg_public_contacts", NOT "contacts").
- Filter operators: eq, neq, like, ilike, gt, gte, lt, lte, is_null. Use \`{ "is_null": true }\` for NULL checks.
- If you are unsure about ANYTHING, call a tool. Do not guess.`;

/** Who an agent call answers for: its role, its session and its request. */
export type AgentCaller = { role: RoleEntities; session?: SessionContext; req?: BunRequest };

export type Agent = (prompt: string, caller: AgentCaller) => Promise<string>;

type AgentSettings = { systemPrompt: string; wrap: (prompt: string) => string; timeoutMs: number };

let settings: AgentSettings | null = null;

/**
 * Store the agent's prompts and its LLM call timeout. Called at boot when the agent is on.
 *
 * Precedence for systemPrompt / promptTemplate:
 *   1. Env-var override (`AI_SYSTEM_PROMPT` / `AI_PROMPT_TEMPLATE`)
 *   2. Config-file value (`ai.systemPrompt`)
 *   3. Built-in default
 */
export const instantiateAI = (
  aiConfig: AIConfig,
  envOverrides?: { systemPrompt?: string; promptTemplate?: string; timeoutMs?: number },
): void => {
  const template = envOverrides?.promptTemplate ?? DEFAULT_AI_PROMPT_TEMPLATE;

  settings = {
    systemPrompt: envOverrides?.systemPrompt ?? aiConfig.systemPrompt ?? DEFAULT_AI_SYSTEM_PROMPT,
    wrap: (prompt: string) => template.replaceAll("{prompt}", prompt),
    timeoutMs: envOverrides?.timeoutMs ?? 0,
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
  const { systemPrompt, wrap, timeoutMs } = settings;

  return (prompt, { role, session, req }) =>
    ask(prompt, buildAgentTools(role, { session, req }), systemPrompt, wrap, timeoutMs);
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

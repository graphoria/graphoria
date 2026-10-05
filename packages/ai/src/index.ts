import type { AgentCaller, AiPackage } from "@graphoria/server";

import { ask } from "./agent/agent";
import { setProvider as setProviderModule } from "./agent/providers";
import { createMCPRoutes as createMCPRoutesModule } from "./mcp";
import { buildAgentTools } from "./tools/agent";

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

/** The prompt defaults the server falls back to when neither env nor config override them. */
export const defaults = {
  systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  promptTemplate: DEFAULT_AI_PROMPT_TEMPLATE,
};

export const createAgent: AiPackage["createAgent"] = (deps, settings) => {
  // A function replacement: a string one would expand `$&`, `$'` and `$$` in the prompt.
  const wrap = (prompt: string) => settings.promptTemplate.replaceAll("{prompt}", () => prompt);

  return (prompt: string, { role, session, req }: AgentCaller) =>
    ask(
      deps.logger,
      prompt,
      buildAgentTools(deps, role, { session, req }),
      settings.systemPrompt,
      wrap,
      settings.timeoutMs,
    );
};

export const createMCPRoutes: AiPackage["createMCPRoutes"] = (deps, roles, options) =>
  createMCPRoutesModule(deps, roles, options);

export const setProvider: AiPackage["setProvider"] = (provider) => setProviderModule(provider);

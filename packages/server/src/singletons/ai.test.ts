process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Env } from "../types/env";
import type { BunRequest } from "bun";
import type { ChatResult, Provider } from "../ai/agent/types";

const { getSchema } = await import("../configuration/getSchemas");
const { StoreMSSQL } = await import("../__test/dataset/store");
const { instantiateAI, getAgent, resetAI, resolveAISurfaces } = await import("./ai");
const { setProvider } = await import("../ai/agent/providers");
const { columnFieldName } = await import("../databases/transformers/graphqlName");

const scripted = (turns: ChatResult[]): Provider => {
  let turn = 0;
  return { chat: async () => turns[turn++] ?? { content: "out of script", toolCalls: [] } };
};

const buildRole = () =>
  getSchema({
    tables: StoreMSSQL.tables,
    storedProcedures: StoreMSSQL.storedProcedures,
    queues: [],
    operations: {},
    remoteSchemas: [],
    remoteREST: [],
  });

describe("AI singleton", () => {
  beforeEach(() => resetAI());
  afterEach(() => setProvider(null));

  it("getAgent throws before instantiateAI", () => {
    expect(() => getAgent()).toThrow(/not enabled/);
  });

  it("instantiateAI stores a callable agent", () => {
    instantiateAI({ enabled: true, endpoint: "/ai", mcp: { enabled: false } });
    expect(typeof getAgent()).toBe("function");
  });

  it("answers each call through the caller's role, session and request", async () => {
    const role = buildRole();
    const table = role.tables[0]!;
    const calls: unknown[][] = [];
    const recorded = {
      ...role,
      handlers: {
        ...role.handlers,
        gql: {
          ...role.handlers.gql,
          handler: async (...args: unknown[]) => {
            calls.push(args);
            return { data: { rows: [] } };
          },
        },
      },
    };
    const session = { sub: "ana@acme.test", role: "user" };
    const req = new Request("http://graphoria.test/rest/ai") as unknown as BunRequest;
    const query = `{ ${table.resolverName}(limit: 1) { ${columnFieldName(table.columns[0]!)} } }`;

    setProvider(
      scripted([
        {
          content: "",
          toolCalls: [{ id: "1", function: { name: "graphql_execute", arguments: { query } } }],
        },
        { content: "done", toolCalls: [] },
      ]),
    );
    instantiateAI({ enabled: true, endpoint: "/ai", mcp: { enabled: false } });

    expect(await getAgent()("how many?", { role: recorded, session, req })).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toBe(req);
    expect(calls[0]![3]).toBe(session);
  });
});

describe("resolveAISurfaces", () => {
  const aiConfig = (enabled: boolean, mcp: boolean) => ({
    enabled,
    endpoint: "/ai",
    mcp: { enabled: mcp },
  });

  const aiEnv = (ai: object = {}, mcp: object = {}) =>
    ({ ai: { graphqlEnabled: true, restEnabled: true, ...ai, mcp } }) as unknown as Env;

  it("follows the config file when no env var is set", () => {
    expect(resolveAISurfaces(aiEnv(), aiConfig(true, false))).toEqual({
      agent: true,
      ask: true,
      rest: true,
      mcp: false,
    });
  });

  it("lets AI_ENABLED override ai.enabled either way", () => {
    expect(resolveAISurfaces(aiEnv({ enabled: false }), aiConfig(true, false)).agent).toBe(false);
    expect(resolveAISurfaces(aiEnv({ enabled: true }), aiConfig(false, false)).agent).toBe(true);
  });

  it("drops the ask field when AI_GRAPHQL_ENABLED is false", () => {
    expect(resolveAISurfaces(aiEnv({ graphqlEnabled: false }), aiConfig(true, false))).toEqual({
      agent: true,
      ask: false,
      rest: true,
      mcp: false,
    });
  });

  it("drops the REST route when AI_REST_ENABLED is false", () => {
    expect(resolveAISurfaces(aiEnv({ restEnabled: false }), aiConfig(true, false))).toEqual({
      agent: true,
      ask: true,
      rest: false,
      mcp: false,
    });
  });

  it("mounts MCP without the agent", () => {
    expect(resolveAISurfaces(aiEnv(), aiConfig(false, true))).toEqual({
      agent: false,
      ask: false,
      rest: false,
      mcp: true,
    });
    expect(resolveAISurfaces(aiEnv({}, { enabled: true }), aiConfig(false, false)).mcp).toBe(true);
  });

  it("lets AI_MCP_ENABLED=false switch off the MCP the config turned on", () => {
    expect(resolveAISurfaces(aiEnv({}, { enabled: false }), aiConfig(false, true)).mcp).toBe(false);
  });

  it("treats a missing ai block as everything off", () => {
    expect(resolveAISurfaces(aiEnv(), undefined)).toEqual({
      agent: false,
      ask: false,
      rest: false,
      mcp: false,
    });
  });
});

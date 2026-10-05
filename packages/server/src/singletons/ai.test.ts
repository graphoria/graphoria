process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Env } from "../types/env";
import type { BunRequest } from "bun";
import type { ChatResult, Provider } from "../ai/adapter";

const { getSchema } = await import("../configuration/getSchemas");
const { StoreMSSQL } = await import("../__test/dataset/store");
const { instantiateAI, getAgent, resetAI, resolveAISurfaces, assertScopedRoles } =
  await import("./ai");
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

  it("bounds each LLM call by the timeout it was instantiated with", async () => {
    // Fails at once rather than hanging when no timeout reaches the provider:
    // a promise nothing settles stalls the runner past its own test timeout.
    setProvider({
      chat: (_messages, _tools, signal) =>
        new Promise((_, reject) => {
          if (!signal) return reject(new Error("no timeout reached the provider"));
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    instantiateAI({ enabled: true, endpoint: "/ai", mcp: { enabled: false } }, { timeoutMs: 20 });

    await expect(getAgent()("q", { role: buildRole() })).rejects.toThrow(
      "LLM call timed out after 20 ms",
    );
  });

  it("hands the prompt to the template verbatim, $ sequences included", async () => {
    const prompt = "orders over $$5, $& and $' and $`";
    const sent: string[] = [];
    setProvider({
      chat: async (messages) => {
        sent.push(messages.find((message) => message.role === "user")!.content);
        throw new Error("stop after the first call");
      },
    });
    instantiateAI(
      { enabled: true, endpoint: "/ai", mcp: { enabled: false } },
      { promptTemplate: "Q: {prompt} (end)" },
    );

    await expect(getAgent()(prompt, { role: buildRole() })).rejects.toThrow("stop");
    expect(sent).toEqual([`Q: ${prompt} (end)`]);
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

describe("assertScopedRoles", () => {
  const surfaces = { agent: true, ask: true, rest: true, mcp: true };
  const roles = {
    superadmin: { entityOfRole: { ai: true } },
    anonymous: { entityOfRole: { ai: false } },
    analyst: { entityOfRole: { ai: true } },
  };
  const envWith = (ai: { secrets?: string[]; secretRole?: string }, mcp: object = {}) =>
    ({
      superadmin: { role: "superadmin" },
      anonymousRole: "anonymous",
      ai: { secrets: [], ...ai, mcp: { secrets: [], ...mcp } },
    }) as unknown as Env;

  it("accepts the defaults", () => {
    expect(() =>
      assertScopedRoles(envWith({ secrets: ["s"] }, { secrets: ["m"] }), roles, surfaces),
    ).not.toThrow();
  });

  it("refuses an agent credential naming a role the configuration lacks", () => {
    expect(() =>
      assertScopedRoles(envWith({ secrets: ["s"], secretRole: "ghost" }), roles, surfaces),
    ).toThrow('AI_SECRET_ROLE is "ghost", which is not a configured role');
  });

  it.each(["constructor", "__proto__"])(
    "refuses either credential naming %s, which no configuration defines",
    (inherited) => {
      expect(() =>
        assertScopedRoles(envWith({ secrets: ["s"], secretRole: inherited }), roles, surfaces),
      ).toThrow(`AI_SECRET_ROLE is "${inherited}", which is not a configured role`);
      expect(() =>
        assertScopedRoles(envWith({}, { secrets: ["m"], secretRole: inherited }), roles, surfaces),
      ).toThrow(`AI_MCP_SECRET_ROLE is "${inherited}", which is not a configured role`);
    },
  );

  it("refuses an agent credential naming a role not granted ai", () => {
    expect(() =>
      assertScopedRoles(envWith({ secrets: ["s"], secretRole: "anonymous" }), roles, surfaces),
    ).toThrow("permissions.anonymous.ai");
  });

  it("refuses an MCP credential naming a role the configuration lacks", () => {
    expect(() =>
      assertScopedRoles(envWith({}, { secrets: ["m"], secretRole: "ghost" }), roles, surfaces),
    ).toThrow('AI_MCP_SECRET_ROLE is "ghost", which is not a configured role');
  });

  it("does not ask an MCP role for the ai grant", () => {
    expect(() =>
      assertScopedRoles(envWith({}, { secrets: ["m"], secretRole: "anonymous" }), roles, surfaces),
    ).not.toThrow();
  });

  it("ignores a role nobody can present", () => {
    expect(() =>
      assertScopedRoles(envWith({ secretRole: "ghost" }, { secretRole: "ghost" }), roles, surfaces),
    ).not.toThrow();
  });

  it("ignores a surface that is not mounted", () => {
    const off = { agent: false, ask: false, rest: false, mcp: false };
    expect(() =>
      assertScopedRoles(
        envWith({ secrets: ["s"], secretRole: "ghost" }, { secrets: ["m"], secretRole: "ghost" }),
        roles,
        off,
      ),
    ).not.toThrow();
  });

  it("checks the agent credential while the REST route is mounted, not while the agent is on", () => {
    const restOff = { agent: true, ask: true, rest: false, mcp: false };
    expect(() =>
      assertScopedRoles(envWith({ secrets: ["s"], secretRole: "anonymous" }), roles, restOff),
    ).not.toThrow();
  });
});

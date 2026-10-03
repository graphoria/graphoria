process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { afterEach, describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";
import type { Provider, Tool } from "../agent/types";
import type { EntityListItem } from "./core";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { buildAgentTools } = await import("./agent");
const { ask } = await import("../agent/agent");
const { setProvider } = await import("../agent/providers");
const { columnFieldName } = await import("../../databases/transformers/graphqlName");

const buildRole = (includeAI = false) =>
  getSchema(
    {
      tables: StoreMSSQL.tables,
      storedProcedures: StoreMSSQL.storedProcedures,
      queues: [],
      operations: {},
      remoteSchemas: [],
      remoteREST: [],
    },
    null,
    null,
    includeAI,
  );

const findTool = (name: string) => buildAgentTools(buildRole(), {}).find((t) => t.name === name)!;

describe("buildAgentTools", () => {
  it("exposes list_entities, describe_entity, graphql_execute", () => {
    const tools = buildAgentTools(buildRole(), {});
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_entity",
      "graphql_execute",
      "list_entities",
      "query_data",
    ]);
  });

  it("list_entities rejects calls with neither kind nor search", async () => {
    const result = (await findTool("list_entities").execute({})) as {
      error?: string;
    };
    expect(result.error).toBeDefined();
  });

  it("list_entities by kind returns tables", async () => {
    const result = (await findTool("list_entities").execute({
      kind: "table",
    })) as EntityListItem[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((i) => i.kind === "table")).toBe(true);
  });

  it("describe_entity describes a real table", async () => {
    const tables = (await findTool("list_entities").execute({
      kind: "table",
    })) as EntityListItem[];
    const result = (await findTool("describe_entity").execute({
      name: tables[0].name,
    })) as Record<string, unknown>;
    expect(result.kind).toBe("table");
    expect(Array.isArray(result.columns)).toBe(true);
  });

  it("describe_entity returns an error object for an unknown entity", async () => {
    const result = (await findTool("describe_entity").execute({
      name: "__does_not_exist__",
    })) as { error?: string };
    expect(result.error).toBeDefined();
  });

  it("graphql_execute rejects mutations", async () => {
    const result = (await findTool("graphql_execute").execute({
      query: "mutation { whatever }",
    })) as { error?: string };
    expect(result.error).toContain("query");
  });

  it("graphql_execute reports validation errors for unknown fields", async () => {
    const result = (await findTool("graphql_execute").execute({
      query: "query { __nope_field }",
    })) as { data: null; errors: unknown[] };
    expect(result.data).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("buildAgentTools — the caller", () => {
  it("runs graphql_execute and query_data as the caller", async () => {
    const role = buildRole();
    const calls: unknown[][] = [];
    const recorded = {
      ...role,
      handlers: {
        ...role.handlers,
        gql: {
          ...role.handlers.gql,
          handler: async (...args: unknown[]) => {
            calls.push(args);
            return { data: {} };
          },
        },
      },
    };
    const session = { sub: "ana@acme.test", role: "user" };
    const req = new Request("http://graphoria.test/rest/ai") as unknown as BunRequest;
    const table = role.tables[0]!;
    const field = columnFieldName(table.columns[0]!);
    const tools = buildAgentTools(recorded, { session, req });

    await tools
      .find((t) => t.name === "graphql_execute")!
      .execute({ query: `{ ${table.resolverName}(limit: 1) { ${field} } }` });
    await tools
      .find((t) => t.name === "query_data")!
      .execute({ entity: table.resolverName, operation: "list", columns: [field], limit: 1 });

    expect(calls.map((call) => [call[2], call[3]])).toEqual([
      [req, session],
      [req, session],
    ]);
  });
});

describe("buildAgentTools — query_data", () => {
  afterEach(() => setProvider(null));

  const recording = () => {
    const role = buildRole();
    const queries: unknown[] = [];
    const tools = buildAgentTools(
      {
        ...role,
        handlers: {
          ...role.handlers,
          gql: {
            ...role.handlers.gql,
            handler: async (query: string) => {
              queries.push(query);
              return { data: {} };
            },
          },
        },
      },
      {},
    );
    const table = role.tables[0]!;
    return { queries, tools, table, field: columnFieldName(table.columns[0]!) };
  };

  // Calls query_data once, then answers with what the tool returned.
  const callingQueryData = (args: Record<string, unknown>): Provider => ({
    chat: async (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === "tool") return { content: last.content, toolCalls: [] };
      return {
        content: "",
        toolCalls: [{ id: "q", function: { name: "query_data", arguments: args } }],
      };
    },
  });

  const askWith = (tools: Tool[], args: Record<string, unknown>) => {
    setProvider(callingQueryData(args));
    return ask("question", tools, "system", (prompt) => prompt);
  };

  it("selects every column the role reads when it names none", async () => {
    const { queries, tools, table } = recording();
    const fields = table.columns.map(columnFieldName).join(" ");

    await tools
      .find((t) => t.name === "query_data")!
      .execute({ entity: table.resolverName, operation: "list", limit: 1 });

    expect(queries).toEqual([`query { ${table.resolverName}(limit: 1) { ${fields} } }`]);
  });

  it("reads filters sent as a JSON string as the object they spell", async () => {
    const { queries, tools, table, field } = recording();
    const listing = { entity: table.resolverName, operation: "list", columns: [field], limit: 1 };
    const filters = { [field]: { eq: 1 } };

    await askWith(tools, { ...listing, filters: JSON.stringify(filters) });
    await askWith(tools, { ...listing, filters });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain(`where: { ${field}: { eq: 1 } }`);
    expect(queries[0]).toBe(queries[1]);
  });

  it("still refuses a reserved key in filters sent as a JSON string", async () => {
    const { queries, tools, table, field } = recording();

    const answer = await askWith(tools, {
      entity: table.resolverName,
      operation: "list",
      columns: [field],
      limit: 1,
      filters: '{ "__proto__": { "eq": 1 } }',
    });

    const { error } = JSON.parse(answer) as { error: string };
    expect(error).toContain("__proto__");
    expect(error).toContain("is reserved: GraphQL keeps names starting with __");
    expect(queries).toEqual([]);
  });
});

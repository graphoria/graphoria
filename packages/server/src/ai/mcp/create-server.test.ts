process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AnalyzedConfiguration } from "../../configuration";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { createMcpServer } = await import("./create-server");
const { GRAPHORIA_MCP_INSTRUCTIONS } = await import("./instructions");

const buildAnalyzedConfig = (): AnalyzedConfiguration => {
  const role = getSchema({
    tables: StoreMSSQL.tables,
    storedProcedures: StoreMSSQL.storedProcedures,
    queues: [],
    operations: {},
    remoteSchemas: [],
    remoteREST: [],
  });
  return {
    databases: [],
    roles: { anonymous: role },
    openapi: {
      openapi: "3.1.0",
      info: { title: "test", version: "1.0.0" },
      paths: {},
    },
    queues: [],
    auth: { enabled: false },
  } as unknown as AnalyzedConfiguration;
};

type PromptMessage = {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
};

type Internal = {
  _registeredTools: Record<
    string,
    {
      handler: (args: unknown, ctx: unknown) => Promise<CallToolResult>;
    }
  >;
  _registeredResources: Record<
    string,
    {
      readCallback: (
        uri: URL,
        ctx: unknown,
      ) => Promise<{ contents: Array<{ text: string; uri: string }> }>;
    }
  >;
  _registeredPrompts: Record<
    string,
    {
      handler: (
        args: Record<string, unknown> | undefined,
        ctx: unknown,
      ) => Promise<{ messages: PromptMessage[] }>;
    }
  >;
};

const callTool = async (
  server: ReturnType<typeof createMcpServer>,
  name: string,
  args: unknown,
): Promise<CallToolResult> => {
  const internal = server as unknown as Internal;
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`Tool '${name}' not registered`);
  return tool.handler(args, {});
};

const callPrompt = async (
  server: ReturnType<typeof createMcpServer>,
  name: string,
  args: Record<string, unknown>,
) => {
  const internal = server as unknown as Internal;
  const prompt = internal._registeredPrompts[name];
  if (!prompt) throw new Error(`Prompt '${name}' not registered`);
  return prompt.handler(args, {});
};

const readResource = async (server: ReturnType<typeof createMcpServer>, uri: string) => {
  const internal = server as unknown as Internal;
  const resource = internal._registeredResources[uri];
  if (!resource) throw new Error(`Resource '${uri}' not registered`);
  return resource.readCallback(new URL(uri), {});
};

const textOf = (result: CallToolResult): string => {
  const block = result.content[0];
  if (block.type !== "text") throw new Error("Expected text content");
  return block.text;
};

describe("createMcpServer", () => {
  it("registers exactly 5 tools, 3 resources, and 1 prompt", () => {
    const server = createMcpServer(buildAnalyzedConfig());
    const internal = server as unknown as Internal;
    expect(Object.keys(internal._registeredTools).sort()).toEqual([
      "describe_entity",
      "graphql_execute",
      "graphql_validate",
      "list_entities",
      "query_data",
      "rest_execute",
    ]);
    expect(Object.keys(internal._registeredResources).sort()).toEqual([
      "graphql://introspection",
      "graphql://schema",
      "openapi://spec",
    ]);
    expect(Object.keys(internal._registeredPrompts).sort()).toEqual(["db_query"]);
  });

  it("disabledTools omits listed tools by name", () => {
    const server = createMcpServer(buildAnalyzedConfig(), {
      disabledTools: ["rest_execute", "graphql_execute"],
    });
    const internal = server as unknown as Internal;
    expect(Object.keys(internal._registeredTools).sort()).toEqual([
      "describe_entity",
      "graphql_validate",
      "list_entities",
      "query_data",
    ]);
  });

  it("disabledResources omits by URI or name", () => {
    const server = createMcpServer(buildAnalyzedConfig(), {
      disabledResources: ["graphql://introspection", "openapi-spec"],
    });
    const internal = server as unknown as Internal;
    expect(Object.keys(internal._registeredResources).sort()).toEqual(["graphql://schema"]);
  });

  it("uses provided name and version on the server impl", () => {
    const server = createMcpServer(buildAnalyzedConfig(), {
      name: "my-app",
      version: "9.9.9",
    });
    const impl = (
      server as unknown as { server: { _serverInfo: { name: string; version: string } } }
    ).server._serverInfo;
    expect(impl.name).toBe("my-app");
    expect(impl.version).toBe("9.9.9");
  });

  it("ships Graphoria-specific GraphQL guidance in the MCP instructions", () => {
    for (const marker of ["_aggregate", "groupBy", "count", "where", "ASC_NULLS_FIRST"]) {
      expect(GRAPHORIA_MCP_INSTRUCTIONS).toContain(marker);
    }
    const server = createMcpServer(buildAnalyzedConfig());
    const instructions = (server as unknown as { server: { _instructions?: string } }).server
      ._instructions;
    expect(instructions).toBe(GRAPHORIA_MCP_INSTRUCTIONS);
  });

  it("maxQueryDepth rejects queries that exceed the limit", async () => {
    const server = createMcpServer(buildAnalyzedConfig(), {
      maxQueryDepth: 1,
    });
    const result = await callTool(server, "graphql_validate", {
      query: "{ dbo_products { dbo_product_categories { category_id } } }",
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.valid).toBe(false);
    expect(JSON.stringify(parsed.errors)).toMatch(/depth/i);
  });

  it("throws when the anonymous role is missing", () => {
    expect(() =>
      createMcpServer({
        databases: [],
        roles: {},
        openapi: {},
        queues: [],
        auth: { enabled: false },
      } as unknown as AnalyzedConfiguration),
    ).toThrow(/anonymous/);
  });

  describe("graphql_validate", () => {
    it("flags unknown fields", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "graphql_validate", {
        query: "{ does_not_exist { id } }",
      });
      const parsed = JSON.parse(textOf(result));
      expect(parsed.valid).toBe(false);
      expect(parsed.errors.length).toBeGreaterThan(0);
    });

    it("accepts a valid query", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "graphql_validate", {
        query: "{ dbo_products { product_id } }",
      });
      const parsed = JSON.parse(textOf(result));
      expect(parsed.valid).toBe(true);
      expect(parsed.errors).toEqual([]);
    });
  });

  describe("graphql_execute", () => {
    it("rejects mutations", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "graphql_execute", {
        query: 'mutation { auth_login(username: "x", password: "y") { access_token } }',
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/query.*operations are allowed/i);
    });

    it("rejects subscriptions", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "graphql_execute", {
        query: "subscription { dbo_products { product_id } }",
      });
      expect(result.isError).toBe(true);
    });

    it("returns validation errors for invalid query without throwing", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "graphql_execute", {
        query: "{ does_not_exist { id } }",
      });
      const parsed = JSON.parse(textOf(result));
      expect(parsed.errors.length).toBeGreaterThan(0);
      expect(parsed.data).toBeNull();
    });
  });

  describe("list_entities", () => {
    it("lists tables", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "list_entities", {
        kind: "table",
      });
      const parsed = JSON.parse(textOf(result));
      const names = parsed.map((e: { name: string }) => e.name);
      expect(names).toContain("dbo_products");
      for (const entry of parsed) {
        expect(entry.kind).toBe("table");
      }
    });

    it("filters by case-insensitive search term", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "list_entities", {
        search: "PRODUCT",
      });
      const parsed = JSON.parse(textOf(result));
      const names = parsed.map((e: { name: string }) => e.name);
      expect(names).toContain("dbo_products");
      expect(names.every((n: string) => n.toLowerCase().includes("product"))).toBe(true);
    });

    it("rejects calls with neither kind nor search", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "list_entities", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/kind.*search|search.*kind/);
    });

    it("matches search against tableDescription when the name doesn't contain the term", async () => {
      const cfg = buildAnalyzedConfig();
      const cryptic = cfg.roles.anonymous.tables.find((t) => t.resolverName === "dbo_products");
      if (!cryptic) throw new Error("fixture missing dbo_products");
      cryptic.tableDescription =
        "Master inventory of widgets, gadgets, and other sellable merchandise.";

      const server = createMcpServer(cfg);
      const result = await callTool(server, "list_entities", {
        search: "merchandise",
      });
      const parsed = JSON.parse(textOf(result)) as Array<{ name: string }>;
      expect(parsed.map((e) => e.name)).toContain("dbo_products");
    });

    it("surfaces tableDescription on table entries", async () => {
      const cfg = buildAnalyzedConfig();
      const target = cfg.roles.anonymous.tables.find((t) => t.resolverName === "dbo_products");
      if (!target) throw new Error("fixture missing dbo_products");
      target.tableDescription = "Catalog of sellable products.";

      const server = createMcpServer(cfg);
      const result = await callTool(server, "list_entities", { kind: "table" });
      const parsed = JSON.parse(textOf(result)) as Array<{
        name: string;
        description: string | null;
      }>;
      const entry = parsed.find((e) => e.name === "dbo_products");
      expect(entry?.description).toBe("Catalog of sellable products.");
      const other = parsed.find((e) => e.name !== "dbo_products");
      expect(other?.description).toBeNull();
    });
  });

  describe("describe_entity", () => {
    it("returns columns + relationships for a table and infers kind", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "describe_entity", {
        name: "dbo_products",
      });
      const parsed = JSON.parse(textOf(result));
      expect(parsed.kind).toBe("table");
      expect(parsed.columns.length).toBeGreaterThan(0);
      expect(parsed.columns[0]).toHaveProperty("name");
      expect(parsed.columns[0]).toHaveProperty("dataType");
      expect(Array.isArray(parsed.relationships)).toBe(true);
      expect(Array.isArray(parsed.relationshipsReversed)).toBe(true);
      expect(parsed.graphqlField?.rootKind).toBe("Query");
    });

    it("returns an error for an unknown entity", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "describe_entity", {
        name: "no_such_entity",
      });
      expect(result.isError).toBe(true);
    });

    it("emits table-specific example queries that validate against the schema", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callTool(server, "describe_entity", {
        name: "dbo_products",
      });
      const parsed = JSON.parse(textOf(result));

      expect(parsed.aggregateField?.rootKind).toBe("Query");
      expect(parsed.aggregateField?.signature).toContain("dbo_products_aggregate");
      expect(parsed.aggregateField?.signature).toContain("groupBy");

      expect(parsed.examples).toBeTruthy();
      expect(parsed.examples.list).toContain("dbo_products(limit: 10)");
      expect(parsed.examples.aggregate).toContain("dbo_products_aggregate(groupBy:");
      expect(parsed.examples.aggregate).toContain("key {");
      expect(parsed.examples.aggregate).toContain("count");

      const validateExample = async (query: string) => {
        const res = await callTool(server, "graphql_validate", { query });
        const out = JSON.parse(textOf(res));
        expect(out.valid).toBe(true);
      };
      await validateExample(parsed.examples.list);
      await validateExample(parsed.examples.aggregate);
      if (parsed.examples.filter) await validateExample(parsed.examples.filter);
    });
  });

  describe("resources", () => {
    it("graphql://schema returns SDL", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const res = await readResource(server, "graphql://schema");
      const text = res.contents[0].text;
      expect(text).toContain("type Query");
      expect(text).toContain("dbo_products");
    });

    it("graphql://introspection returns parseable JSON with __schema", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const res = await readResource(server, "graphql://introspection");
      const parsed = JSON.parse(res.contents[0].text);
      expect(parsed.__schema).toBeDefined();
    });

    it("openapi://spec returns parseable JSON", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const res = await readResource(server, "openapi://spec");
      const parsed = JSON.parse(res.contents[0].text);
      expect(parsed.openapi).toBe("3.1.0");
    });
  });

  describe("db_query prompt", () => {
    it("embeds the user's question and the aggregate workflow", async () => {
      const server = createMcpServer(buildAnalyzedConfig());
      const result = await callPrompt(server, "db_query", {
        question: "how many products are there?",
      });
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
      const text = result.messages[0].content.text;
      expect(text).toContain("how many products are there?");
      expect(text).toContain("list_entities");
      expect(text).toContain("describe_entity");
      expect(text).toContain("_aggregate");
      expect(text).toContain("groupBy");
      expect(text).toContain("key {");
    });

    it("disabledPrompts omits db_query", () => {
      const server = createMcpServer(buildAnalyzedConfig(), {
        disabledPrompts: ["db_query"],
      });
      const internal = server as unknown as Internal;
      expect(Object.keys(internal._registeredPrompts)).toEqual([]);
    });
  });
});

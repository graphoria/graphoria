process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";

import type { BunRequest } from "bun";
import type { EntityListItem } from "./core";

const { getSchema } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { buildAgentTools } = await import("./agent");
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

const findTool = (name: string) => buildAgentTools(buildRole()).find((t) => t.name === name)!;

describe("buildAgentTools", () => {
  it("exposes list_entities, describe_entity, graphql_execute", () => {
    const tools = buildAgentTools(buildRole());
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

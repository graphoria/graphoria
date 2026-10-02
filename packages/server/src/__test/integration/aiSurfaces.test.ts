import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";

import type { Env } from "../../types/env";
import type { StartedServer } from "./harness";

import { integrationEnabled, startServer } from "./harness";
import { callMcpTool } from "./mcp";

/**
 * Each AI surface mounts from its own flag, env over config: MCP without the
 * agent, the agent without its GraphQL field, the REST route under
 * REST_API_PREFIX, and an OpenAPI path only where a route answers.
 *
 * PostgreSQL only: nothing here touches the query builder.
 */

const ENGINE = "pg" as const;

describe.skipIf(!integrationEnabled)("AI surfaces", () => {
  let baseAi: Env["ai"];
  let aiModule: typeof import("../../singletons/ai");

  beforeAll(async () => {
    baseAi = (await import("../../singletons/env")).env.ai;
    aiModule = await import("../../singletons/ai");
  });

  const url = (started: StartedServer, path: string) =>
    `http://localhost:${started.context.server.port}${path}`;

  const askAsAdmin = (started: StartedServer, path: string) =>
    Bun.fetch(url(started, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": process.env["ADMIN_SECRET"]!,
      },
      body: JSON.stringify({ prompt: "how many users?" }),
    });

  const withStubbedAgent = async (run: () => Promise<Response>) => {
    const spy = spyOn(aiModule, "getAgent").mockReturnValue(async () => "forty-two");
    try {
      return await run();
    } finally {
      spy.mockRestore();
    }
  };

  const openapi = async (started: StartedServer) =>
    (await (await Bun.fetch(url(started, "/openapi.json"))).json()) as {
      servers: { url: string }[];
      paths: Record<string, unknown>;
    };

  describe("MCP on, agent off", () => {
    let started: StartedServer;

    beforeAll(async () => {
      started = await startServer({
        engine: ENGINE,
        config: { ai: { enabled: false, mcp: { enabled: true } } } as never,
        env: { ai: { ...baseAi, enabled: undefined, mcp: { ...baseAi.mcp, enabled: undefined } } },
      });
    });

    afterAll(async () => {
      await started?.stop();
    });

    it("mounts /mcp", async () => {
      const call = await callMcpTool(url(started, "/mcp"), "graphql_validate", {
        query: "{ __typename }",
      });

      expect(call).toMatchObject({ status: 200, result: { valid: true } });
    });

    it("mounts no agent route", async () => {
      expect((await askAsAdmin(started, "/rest/ai")).status).toBe(404);
    });
  });

  describe("AI_ENABLED over the config, AI_GRAPHQL_ENABLED=false", () => {
    let started: StartedServer;

    beforeAll(async () => {
      started = await startServer({
        engine: ENGINE,
        config: { ai: { enabled: false } } as never,
        env: { ai: { ...baseAi, enabled: true, graphqlEnabled: false, restEnabled: true } },
      });
    });

    afterAll(async () => {
      await started?.stop();
    });

    it("mounts the REST route the env var turned on", async () => {
      const response = await withStubbedAgent(() => askAsAdmin(started, "/rest/ai"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ answer: "forty-two" });
    });

    it("leaves the ask field out of the schema", async () => {
      const response = await started.context.gql('{ ask(prompt: "x") }', undefined, {
        admin: true,
      });

      expect(response.errors?.[0]?.message).toMatch(/Cannot query field "ask"/);
    });
  });

  describe("REST_API_PREFIX=/api", () => {
    let started: StartedServer;

    beforeAll(async () => {
      started = await startServer({
        engine: ENGINE,
        config: { ai: { enabled: true } } as never,
        env: { restApiPrefix: "/api", ai: { ...baseAi, enabled: undefined, restEnabled: true } },
      });
    });

    afterAll(async () => {
      await started?.stop();
    });

    it("mounts the agent under the REST prefix", async () => {
      const response = await withStubbedAgent(() => askAsAdmin(started, "/api/ai"));

      expect(response.status).toBe(200);
      expect((await askAsAdmin(started, "/rest/ai")).status).toBe(404);
    });

    it("describes the route where it answers", async () => {
      const spec = await openapi(started);

      expect(spec.servers[0]!.url).toBe("/api");
      expect(spec.paths["/ai"]).toBeDefined();
    });
  });

  describe("AI_REST_ENABLED=false", () => {
    let started: StartedServer;

    beforeAll(async () => {
      started = await startServer({
        engine: ENGINE,
        config: { ai: { enabled: true } } as never,
        env: { ai: { ...baseAi, enabled: undefined, restEnabled: false } },
      });
    });

    afterAll(async () => {
      await started?.stop();
    });

    it("leaves the unmounted route out of the OpenAPI document", async () => {
      expect((await openapi(started)).paths["/ai"]).toBeUndefined();
    });
  });
});

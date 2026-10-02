import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Message, Provider } from "../../../ai/agent/types";
import type { DatabaseType } from "../../../types/configuration";
import type { StartedRls } from "./fixture";

import { ENGINES, fieldName } from "../config";
import { integrationEnabled } from "../harness";
import { startRlsServer } from "./fixture";

/**
 * The AI agent reads what its caller reads. A scripted provider stands in for
 * the LLM: it runs one `graphql_execute` over the tasks table, then answers
 * with the tool's raw result, so an answer is exactly the rows the caller's
 * role and session let through.
 *
 * `ana` (role `user`, granted `ai`) owns tasks 1 and 6; Umbrella's are 7-10.
 * `dept` (role `project_member`) is not granted `ai`.
 */

const ANA_TASKS = [1, 6];
const UMBRELLA_TASKS = [7, 8, 9, 10];
const PROMPT = "which tasks can I see?";

const echoProvider = (tasks: string): Provider => ({
  chat: async (messages: Message[]) => {
    const last = messages[messages.length - 1]!;
    if (last.role === "tool") return { content: last.content, toolCalls: [] };

    return {
      content: "",
      toolCalls: [
        {
          id: "tasks",
          function: {
            name: "graphql_execute",
            arguments: { query: `{ ${tasks}(orderBy: [{ id: ASC }]) { id } }` },
          },
        },
      ],
    };
  },
});

const taskIds = (payload: string, tasks: string): number[] => {
  const parsed = JSON.parse(payload) as { data?: Record<string, { id: unknown }[]> };
  return (parsed.data?.[tasks] ?? []).map((row) => Number(row.id));
};

describe.skipIf(!integrationEnabled)("rls · AI agent and MCP", () => {
  for (const engine of ENGINES as readonly DatabaseType[]) {
    describe(engine, () => {
      let started: StartedRls;
      let setProvider: (provider: Provider | null) => void;

      const tasks = fieldName(engine, "app", "tasks");

      beforeAll(async () => {
        started = await startRlsServer(engine, { config: { ai: { enabled: true } } });
        ({ setProvider } = await import("../../../ai/agent/providers"));
        setProvider(echoProvider(tasks));
      });

      afterAll(async () => {
        setProvider?.(null);
        await started?.stop();
      });

      const bearer = async (key: "ana" | "dept") => ({
        authorization: `Bearer ${await started.context.tokenFor(key)}`,
      });

      const admin = () => ({ "x-admin-secret": process.env["ADMIN_SECRET"]! });

      const askRest = (headers: Record<string, string>) =>
        started.context.rest("/ai", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ prompt: PROMPT }),
        });

      describe("agent", () => {
        it("answers ana over REST with her own rows only", async () => {
          const response = await askRest(await bearer("ana"));

          expect(response.status).toBe(200);
          const { answer } = (await response.json()) as { answer: string };
          expect(taskIds(answer, tasks)).toEqual(ANA_TASKS);
        });

        it("answers ana through the ask field with her own rows only", async () => {
          const response = await started.context.gql<{ ask: string }>(
            "query Ask($prompt: String!) { ask(prompt: $prompt) }",
            { prompt: PROMPT },
            { token: await started.context.tokenFor("ana") },
          );

          expect(response.errors).toBeUndefined();
          expect(taskIds(response.data!.ask, tasks)).toEqual(ANA_TASKS);
        });

        it("shows the admin secret every tenant", async () => {
          const { answer } = (await (await askRest(admin())).json()) as { answer: string };

          expect(taskIds(answer, tasks)).toEqual(
            expect.arrayContaining([...ANA_TASKS, ...UMBRELLA_TASKS]),
          );
        });

        it("keeps a role without ai away from the route and the field", async () => {
          expect((await askRest(await bearer("dept"))).status).toBe(404);

          const response = await started.context.gql('{ ask(prompt: "x") }', undefined, {
            token: await started.context.tokenFor("dept"),
          });
          expect(response.errors?.[0]?.message).toMatch(/Cannot query field "ask"/);
        });

        it("keeps an anonymous caller away from the route", async () => {
          expect((await askRest({})).status).toBe(404);
        });
      });
    });
  }
});

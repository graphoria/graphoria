import { describe, expect, it } from "bun:test";

import { buildExecute } from "./buildExecute";

type HandlerCall = {
  query: string;
  variables: Record<string, unknown>;
  req: unknown;
  session: unknown;
};

const makeGql = (
  calls: HandlerCall[],
  overrides: Partial<{
    isNoDataQuery: (q: string) => boolean;
    hasErrors: (q: string) => { hasErrors: boolean; validationErrors: unknown[] };
    handlerData: unknown;
  }> = {},
) => ({
  isNoDataQuery: overrides.isNoDataQuery ?? ((q: string) => q.includes("_no_data")),
  noDataResult: { data: { _no_data: "No data available" } },
  hasErrors: overrides.hasErrors ?? (() => ({ hasErrors: false, validationErrors: [] })),
  handler: async (
    query: string,
    variables: Record<string, unknown>,
    req: unknown,
    session: unknown,
  ) => {
    calls.push({ query, variables, req, session });
    return { data: overrides.handlerData ?? { ok: true } };
  },
});

const makeRoles = (gqls: Record<string, ReturnType<typeof makeGql>>) =>
  Object.fromEntries(
    Object.entries(gqls).map(([role, gql]) => [role, { handlers: { gql } }]),
  ) as unknown as Parameters<typeof buildExecute>[0];

describe("buildExecute", () => {
  it("validates a __schema query and hands it to the handler like any other", async () => {
    const calls: HandlerCall[] = [];
    const validated: string[] = [];
    const gql = makeGql(calls, {
      hasErrors: (q) => {
        validated.push(q);
        return { hasErrors: false, validationErrors: [] };
      },
    });
    const execute = buildExecute(makeRoles({ superadmin: gql }), "superadmin");
    const query = "{ __schema { types { name } } }";

    expect(await execute(query)).toEqual({ data: { ok: true } });
    expect(validated).toEqual([query]);
    expect(calls.map((call) => call.query)).toEqual([query]);
  });

  it("short-circuits no-data queries", async () => {
    const calls: HandlerCall[] = [];
    const gql = makeGql(calls);
    const execute = buildExecute(makeRoles({ superadmin: gql }), "superadmin");

    const result = await execute("{ _no_data }");

    expect(result).toBe(gql.noDataResult);
    expect(calls).toHaveLength(0);
  });

  it("maps validation errors to { errors }", async () => {
    const calls: HandlerCall[] = [];
    const gql = makeGql(calls, {
      hasErrors: () => ({
        hasErrors: true,
        validationErrors: [{ message: "bad field", locations: [{ line: 1, column: 3 }] }],
      }),
    });
    const execute = buildExecute(makeRoles({ superadmin: gql }), "superadmin");

    const result = await execute("{ bad }");

    expect(result).toEqual({
      errors: [{ message: "bad field", locations: [{ line: 1, column: 3 }] }],
    });
    expect(calls).toHaveLength(0);
  });

  it("dispatches to the default role with req=undefined", async () => {
    const calls: HandlerCall[] = [];
    const gql = makeGql(calls, { handlerData: { hello: "world" } });
    const execute = buildExecute(makeRoles({ superadmin: gql }), "superadmin");

    const result = await execute("{ hello }", { a: 1 });

    expect(result).toEqual({ data: { hello: "world" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ query: "{ hello }", variables: { a: 1 } });
    expect(calls[0]!.req).toBeUndefined();
    expect(calls[0]!.session).toBeUndefined();
  });

  it("dispatches to an explicit role and passes the session through", async () => {
    const adminCalls: HandlerCall[] = [];
    const userCalls: HandlerCall[] = [];
    const execute = buildExecute(
      makeRoles({
        superadmin: makeGql(adminCalls),
        user: makeGql(userCalls, { handlerData: { scoped: true } }),
      }),
      "superadmin",
    );

    const session = { role: "user" } as never;
    const result = await execute("{ scoped }", {}, { role: "user", session });

    expect(result).toEqual({ data: { scoped: true } });
    expect(adminCalls).toHaveLength(0);
    expect(userCalls).toHaveLength(1);
    expect(userCalls[0]!.session).toBe(session);
  });

  it("throws on an unknown role", async () => {
    const execute = buildExecute(makeRoles({ superadmin: makeGql([]) }), "superadmin");

    await expect(execute("{ hello }", {}, { role: "ghost" })).rejects.toThrow(
      "Unknown role: ghost",
    );
  });
});

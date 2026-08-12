import { describe, expect, it } from "bun:test";
import { parse } from "graphql";
import { z } from "zod";

import { operation } from "./operationHelper";

// Stand-in for a gql.tada `graphql()` document: a DocumentNode that carries its
// result type on the `__apiType` phantom property.
type TadaLike<TResult> = ReturnType<typeof parse> & {
  __apiType?: (variables: Record<string, never>) => TResult;
};

describe("operation() query documents", () => {
  it("normalizes a DocumentNode query to a string", () => {
    const op = operation({
      query: parse("query { ping }"),
      rest: { path: "/ping" },
    }) as { query: unknown };

    expect(typeof op.query).toBe("string");
    expect(op.query).toContain("ping");
  });

  it("leaves a string query unchanged", () => {
    const op = operation({
      query: "query { ping }",
      rest: { path: "/ping" },
    }) as { query: unknown };

    expect(op.query).toBe("query { ping }");
  });

  it("types afterRequest input from the query document and return from output", () => {
    const doc = parse("query { ping }") as TadaLike<{ ping: boolean }>;

    operation({
      query: doc,
      output: z.object({ ok: z.boolean() }),
      rest: { path: "/ping" },
      hooks: {
        afterRequest: ({ output }) => {
          // Compile-time checks: `output` is the query result, the return is
          // typed by the `output` schema.
          const result: { ping: boolean } = output;
          return { ok: result.ping };
        },
      },
    });

    expect(true).toBe(true);
  });
});

import { describe, expect, it } from "bun:test";
import { parse } from "graphql";
import { z } from "zod";

import type { DefaultInput } from "../types/operation";
import type {
  InferOperationInitData,
  InferOperationInput,
  InferOperationOutput,
} from "./operationHelper";

import { OperationZod } from "../types/operation";
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

describe("operation() input", () => {
  // Type-checked too: the @ts-expect-error fails the build if a non-object
  // schema is accepted again.
  it("takes only an object schema", () => {
    const op = operation({
      handler: async () => "ok",
      // @ts-expect-error input must be a Zod object schema
      input: z.string(),
    });

    expect(OperationZod.safeParse(op).success).toBe(false);
  });
});

describe("operation() handler options", () => {
  // Type-checked too: the @ts-expect-error fails the build if `queues` goes
  // untyped again, which let the call below compile and then throw.
  it("hands the handler the queue manager, which publishes through sendMessage", () => {
    operation({
      handler: async ({ queues }) => {
        // @ts-expect-error a publisher is a key of publisherMap(), not a method
        queues.events_orderCreated({ id: 1 });
        return queues.sendMessage("events_orderCreated", { id: 1 });
      },
    });

    expect(true).toBe(true);
  });
});

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("InferOperation* utilities", () => {
  // Type-checked: an assertion fails the build when its utility resolves to
  // `never`, as all three did for every operation() result.
  it("read a query operation's input, output and init data", () => {
    const op = operation({
      query: "query { ping }",
      input: z.object({ id: z.number() }),
      output: z.object({ ok: z.boolean() }),
      hooks: { init: () => ({ startedAt: 1 }) },
    });

    const input: Equal<InferOperationInput<typeof op>, { id: number }> = true;
    const output: Equal<InferOperationOutput<typeof op>, { ok: boolean }> = true;
    const initData: Equal<InferOperationInitData<typeof op>, { startedAt: number }> = true;

    expect([input, output, initData]).toEqual([true, true, true]);
  });

  it("read a handler operation's input, output and init data", () => {
    const op = operation({
      input: z.object({ title: z.string() }),
      output: z.object({ id: z.number() }),
      hooks: { init: async () => "ready" },
      handler: async () => ({ id: 1 }),
    });

    const input: Equal<InferOperationInput<typeof op>, { title: string }> = true;
    const output: Equal<InferOperationOutput<typeof op>, { id: number }> = true;
    const initData: Equal<InferOperationInitData<typeof op>, string> = true;

    expect([input, output, initData]).toEqual([true, true, true]);
  });

  it("fall back to DefaultInput and unknown without schemas", () => {
    const op = operation({ handler: async () => "ok" });

    const input: Equal<InferOperationInput<typeof op>, DefaultInput> = true;
    const output: Equal<InferOperationOutput<typeof op>, unknown> = true;
    const initData: Equal<InferOperationInitData<typeof op>, unknown> = true;

    expect([input, output, initData]).toEqual([true, true, true]);
  });
});

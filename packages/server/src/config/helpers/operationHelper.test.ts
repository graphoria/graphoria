import { describe, expect, it } from "bun:test";
import { parse } from "graphql";
import { z } from "zod";

import type { ConfigurationFn } from "..";
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
// What a typed client reads from an operation: the type-only carrier.
type CarrierOf<T extends { __operationTypes?: unknown }> = NonNullable<T["__operationTypes"]>;

describe("operation() type carrier", () => {
  const doc = parse("query { ping }") as TadaLike<{ ping: boolean }>;

  // Inside `satisfies ConfigurationFn` on purpose: its contextual return type is
  // what infers a hook-less query's output as `any` without the NoInfer.
  const configure = (({ operation, z }) => ({
    name: "carrier",
    version: "1.0.0",
    operations: {
      getByDefault: operation({ query: "query { ping }", rest: { path: "/a" } }),
      post: operation({ query: "mutation { ping }", rest: { path: "/b", method: "POST" } }),
      withInput: operation({
        query: "query { ping }",
        input: z.object({ id: z.number(), limit: z.number().default(10) }),
        rest: { path: "/c" },
      }),
      bySchema: operation({
        query: doc,
        output: z.object({ ok: z.boolean() }),
        rest: { path: "/d" },
        hooks: { afterRequest: ({ output }) => ({ ok: output.ping }) },
      }),
      byHook: operation({
        query: doc,
        rest: { path: "/e" },
        hooks: { afterRequest: ({ output }) => ({ pinged: output.ping }) },
      }),
      byAsyncHook: operation({
        query: doc,
        rest: { path: "/f" },
        hooks: { afterRequest: async ({ output }) => ({ pinged: output.ping }) },
      }),
      byDocument: operation({ query: doc, rest: { path: "/g" } }),
      handled: operation({
        input: z.object({ title: z.string() }),
        output: z.object({ id: z.number() }),
        rest: { path: "/h", method: "POST" },
        handler: async () => ({ id: 1 }),
      }),
      handledBare: operation({
        rest: { path: "/i", method: "DELETE" },
        handler: async () => "ok",
      }),
    },
  })) satisfies ConfigurationFn;

  type Operations = ReturnType<typeof configure>["operations"];

  it("reads the method from rest.method, GET by default", () => {
    const getByDefault: Equal<CarrierOf<Operations["getByDefault"]>["method"], "GET"> = true;
    const post: Equal<CarrierOf<Operations["post"]>["method"], "POST"> = true;
    const handledBare: Equal<CarrierOf<Operations["handledBare"]>["method"], "DELETE"> = true;

    expect([getByDefault, post, handledBare]).toEqual([true, true, true]);
  });

  it("reads the caller's input: optional where the schema defaults, nothing without a schema", () => {
    const withInput: Equal<
      CarrierOf<Operations["withInput"]>["input"],
      { id: number; limit?: number | undefined }
    > = true;
    const without: Equal<CarrierOf<Operations["getByDefault"]>["input"], void> = true;
    const handled: Equal<CarrierOf<Operations["handled"]>["input"], { title: string }> = true;

    expect([withInput, without, handled]).toEqual([true, true, true]);
  });

  it("reads a query's output from the schema, then the hook, then the document", () => {
    const bySchema: Equal<CarrierOf<Operations["bySchema"]>["output"], { ok: boolean }> = true;
    const byHook: Equal<CarrierOf<Operations["byHook"]>["output"], { pinged: boolean }> = true;
    const byAsyncHook: Equal<CarrierOf<Operations["byAsyncHook"]>["output"], { pinged: boolean }> =
      true;
    const byDocument: Equal<CarrierOf<Operations["byDocument"]>["output"], { ping: boolean }> =
      true;
    const byString: Equal<CarrierOf<Operations["getByDefault"]>["output"], unknown> = true;

    expect([bySchema, byHook, byAsyncHook, byDocument, byString]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("reads a handler's output from the schema, unknown without one", () => {
    const handled: Equal<CarrierOf<Operations["handled"]>["output"], { id: number }> = true;
    const handledBare: Equal<CarrierOf<Operations["handledBare"]>["output"], unknown> = true;

    expect([handled, handledBare]).toEqual([true, true]);
  });

  it("types InferOperationOutput from afterRequest when a query has no output schema", () => {
    const byHook: Equal<InferOperationOutput<Operations["byHook"]>, { pinged: boolean }> = true;

    expect(byHook).toBe(true);
  });

  it("refuses an afterRequest that returns another shape than the output schema", () => {
    operation({
      query: doc,
      output: z.object({ ok: z.boolean() }),
      rest: { path: "/j" },
      hooks: {
        // @ts-expect-error the hook returns the `output` schema's type
        afterRequest: ({ output }) => ({ pinged: output.ping }),
      },
    });

    expect(true).toBe(true);
  });

  it("survives a spread", () => {
    const spread = { ...operation({ query: doc, rest: { path: "/k" } }), timeout: 5 };
    const carrier: Equal<
      CarrierOf<typeof spread>,
      { method: "GET"; input: void; output: { ping: boolean } }
    > = true;

    expect(carrier).toBe(true);
  });

  it("never exists at runtime, and setting it fails validation", () => {
    const op = operation({ handler: async () => "ok", rest: { path: "/l" } });

    expect("__operationTypes" in op).toBe(false);
    expect(OperationZod.safeParse(op).success).toBe(true);
    expect(OperationZod.safeParse({ ...op, __operationTypes: {} }).success).toBe(false);
  });
});

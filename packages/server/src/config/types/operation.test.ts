import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { HandlerOperation } from "./operation";

import { OperationZod } from "./operation";

const query = "query { users { id } }";

describe("OperationZod timeout", () => {
  it("leaves timeout undefined so the operation falls back to QUERY_TIMEOUT_MS", () => {
    const result = OperationZod.parse({ query });

    expect(result.timeout).toBeUndefined();
  });

  // Milliseconds, matching QUERY_TIMEOUT_MS rather than the seconds
  // `connectionOptions` uses — the override and the default it replaces have to
  // read in the same unit.
  it("accepts an override in milliseconds", () => {
    expect(OperationZod.parse({ query, timeout: 60_000 }).timeout).toBe(60_000);
  });

  it("rejects a non-positive timeout", () => {
    expect(OperationZod.safeParse({ query, timeout: 0 }).success).toBe(false);
    expect(OperationZod.safeParse({ query, timeout: -1 }).success).toBe(false);
  });

  it("rejects a fractional timeout", () => {
    expect(OperationZod.safeParse({ query, timeout: 1.5 }).success).toBe(false);
  });
});

describe("OperationZod input", () => {
  it("accepts an object schema, refined or not", () => {
    const input = z.strictObject({ id: z.string() }).refine((value) => value.id !== "");

    expect(OperationZod.safeParse({ query, input }).success).toBe(true);
  });

  // A non-object schema was never applied: REST parses only the `rest.*` schemas
  // and the GraphQL argument is built from the object's properties.
  it("rejects a non-object schema", () => {
    const result = OperationZod.safeParse({ query, input: z.string() });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["input"]);
  });
});

describe("OperationZod cache", () => {
  it("accepts a cache on a query operation", () => {
    expect(OperationZod.safeParse({ query, cache: { ttl: 1_000 } }).success).toBe(true);
  });

  it("rejects a cache on a handler operation, whose response is never cached", () => {
    const result = OperationZod.safeParse({ handler: async () => ({}), cache: { ttl: 1_000 } });

    expect(result.success).toBe(false);
    expect(result.error!.issues).toContainEqual(
      expect.objectContaining({
        path: ["cache"],
        message:
          "Operation 'cache' applies to query operations only: a handler's response is never cached",
      }),
    );
  });

  // Type-checked too: the @ts-expect-error fails the build if a handler
  // operation's type accepts a cache again, which only boot would reject.
  it("types a cache on a handler operation as an error", () => {
    const handlerOperation: HandlerOperation = {
      handler: async () => ({}),
      // @ts-expect-error a handler's response is never cached
      cache: { ttl: 1_000 },
    };

    expect(OperationZod.safeParse(handlerOperation).success).toBe(false);
  });
});

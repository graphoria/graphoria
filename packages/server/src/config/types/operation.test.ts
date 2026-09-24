import { describe, expect, it } from "bun:test";
import { z } from "zod";

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

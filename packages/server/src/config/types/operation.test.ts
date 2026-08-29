import { describe, expect, it } from "bun:test";

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

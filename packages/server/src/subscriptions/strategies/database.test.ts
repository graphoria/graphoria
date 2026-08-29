// The poller this strategy reaches pulls in the env singleton, which parses
// process.env at import time.
process.env.ADMIN_SECRET ??= "test-admin";

import { describe, expect, it } from "bun:test";

import type { SubscriptionContext } from "../types";

// Dynamic, so the assignment above lands before the env singleton parses.
const { createDatabaseSubscriptionStrategy } = await import("./database");

/**
 * The subscription key decides who shares a poller, and every client sharing a
 * poller is served its rows. So each of these asserts the same thing from a
 * different side: two callers get one key only when they asked the same
 * question as the same person.
 */
const strategy = createDatabaseSubscriptionStrategy();

type ContextOverrides = {
  operationName?: string | null;
  role?: string;
  sub?: string;
  alias?: string;
  selections?: unknown[];
  variables?: Record<string, unknown>;
};

const contextFor = ({
  operationName = "Mine",
  role = "user",
  sub = "ana@acme.test",
  alias,
  selections = [{ name: "id" }],
  variables = {},
}: ContextOverrides = {}) =>
  ({
    analysis: {
      operations: [{ name: operationName ?? undefined, fields: [{ name: "app_tasks" }] }],
    },
    field: { name: "app_tasks", alias, selections },
    session: { sub, role },
    variables,
  }) as unknown as SubscriptionContext;

const keyFor = (overrides?: ContextOverrides) => strategy.getSubscriptionKey(contextFor(overrides));

describe("database subscription key", () => {
  it("is stable for the same caller asking the same question", () => {
    expect(keyFor()).toBe(keyFor());
  });

  it("separates two roles", () => {
    expect(keyFor({ role: "user" })).not.toBe(keyFor({ role: "admin" }));
  });

  it("separates two users inside one role", () => {
    expect(keyFor({ sub: "ana@acme.test" })).not.toBe(keyFor({ sub: "eve@umbrella.test" }));
  });

  it("separates two argument sets", () => {
    expect(keyFor({ variables: { id: 1 } })).not.toBe(keyFor({ variables: { id: 6 } }));
  });

  it("separates two selection sets", () => {
    expect(keyFor({ selections: [{ name: "id" }] })).not.toBe(
      keyFor({ selections: [{ name: "id" }, { name: "user_id" }] }),
    );
  });

  it("separates two aliases", () => {
    expect(keyFor({ alias: "mine" })).not.toBe(keyFor({ alias: "theirs" }));
  });

  it("separates two operation names", () => {
    expect(keyFor({ operationName: "Mine" })).not.toBe(keyFor({ operationName: "Theirs" }));
  });

  it("falls back to the field name for an anonymous operation", () => {
    expect(keyFor({ operationName: null })).toContain("app_tasks");
  });
});

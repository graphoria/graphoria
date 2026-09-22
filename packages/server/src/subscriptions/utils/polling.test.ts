import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AnalysisResult } from "../../analyzeQuery/types";
import type { GetSchemaReturn } from "../../configuration/getSchemas";
import type { QueryEventEmitter } from "../types";

import { dbPostgreSQL } from "../../__test/dbMocks";

// `singletons/env` parses process.env at module load. Set required vars before
// any transitive import touches it.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";

const { installSpanSink, stringAttribute } = await import("../../__test/spanSink");
const { databaseAdapters } = await import("../../databases/core/function-mapping");
const { createDatabasePoller } = await import("./polling");

const analysis: AnalysisResult = {
  operations: [
    {
      name: "WatchOrders",
      operation: "subscription",
      variables: [],
      fields: [{ name: "orders" }],
    },
  ],
  fragments: [],
} as unknown as AnalysisResult;

const schemaEntity = {
  queriesMap: { orders: { db: dbPostgreSQL } },
} as unknown as GetSchemaReturn;

const eventEmitter = { sendDataUpdate: () => undefined } as unknown as QueryEventEmitter;

describe("createDatabasePoller — tracing", () => {
  const restorers: Array<() => void> = [];
  let sink: ReturnType<typeof installSpanSink>;
  let hash: string;

  const stub = <M extends "query" | "execute" | "executeJson">(
    method: M,
    impl: (typeof databaseAdapters)["pg"][M],
  ) => {
    const original = databaseAdapters.pg[method];
    databaseAdapters.pg[method] = impl;
    restorers.push(() => {
      databaseAdapters.pg[method] = original;
    });
  };

  beforeEach(() => {
    restorers.length = 0;
    hash = "first";
    sink = installSpanSink();
    stub("query", ((
      _entities: unknown,
      _operation: unknown,
      _variables: unknown,
      forHash: boolean,
    ) => (forHash ? "SELECT hash" : "SELECT data")) as never);
    stub("execute", (async () => [{ ResultHash: hash }]) as never);
    stub("executeJson", (async () => ({ orders: [] })) as never);
  });

  afterEach(() => {
    sink.restore();
    while (restorers.length) restorers.pop()?.();
  });

  const poller = async () =>
    createDatabasePoller({
      analysis,
      variableDefinitions: [],
      variables: {},
      schemaEntity,
      subscriptionKey: "sub-1",
      eventEmitter,
      pollIntervalMs: 5,
      role: "user",
    });

  it("roots a trace for the initial fetch, carrying the operation and the role", async () => {
    await poller();

    const spans = await sink.spans();
    const poll = spans.find((span) => span.name === "subscription.poll")!;

    expect(poll.parentSpanId).toBeUndefined();
    expect(stringAttribute(poll, "graphql.operation.name")).toBe("WatchOrders");
    expect(stringAttribute(poll, "graphql.operation.type")).toBe("subscription");
    expect(stringAttribute(poll, "graphoria.role")).toBe("user");
  });

  it("puts the statements it runs under the poll span", async () => {
    await poller();

    const spans = await sink.spans();
    const poll = spans.find((span) => span.name === "subscription.poll")!;
    const statements = spans.filter((span) => span.name === "db.query");

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.traceId).toBe(poll.traceId);
      expect(statement.parentSpanId).toBe(poll.spanId);
    }
  });

  it("spans a tick that finds nothing changed", async () => {
    const created = await poller();
    const before = (await sink.spans()).filter((span) => span.name === "subscription.poll").length;

    created.start();
    await Bun.sleep(30);
    created.stop();

    const after = (await sink.spans()).filter((span) => span.name === "subscription.poll").length;

    expect(after).toBeGreaterThan(before);
  });

  it("gives each tick its own trace", async () => {
    const created = await poller();

    created.start();
    await Bun.sleep(30);
    created.stop();

    const polls = (await sink.spans()).filter((span) => span.name === "subscription.poll");

    expect(polls.length).toBeGreaterThan(1);
    expect(new Set(polls.map((span) => span.traceId)).size).toBe(polls.length);
  });

  it("records nothing while tracing is disabled", async () => {
    sink.restore();

    await poller();

    expect(await sink.spans()).toHaveLength(0);
  });
});

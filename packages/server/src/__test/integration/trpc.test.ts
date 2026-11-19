import { RedisClient } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  createTRPCClient,
  httpBatchLink,
  httpBatchStreamLink,
  TRPCClientError,
} from "@trpc/client";

import type { TRPCRouterOf } from "../../trpc";
import type { StartedServer } from "./harness";

import { operation, z } from "../../config";
import { flushSpans } from "../../observability/tracing";
import { fieldName, REDIS_URL } from "./config";
import { integrationEnabled, startServer } from "./harness";

/**
 * The tRPC surface behind a real Bun.serve, called over HTTP by a real
 * @trpc/client. Engine-agnostic: a query operation reaches the database through
 * the GraphQL handler, as on REST, so one engine proves it. This suite runs
 * without the unit suite's happy-dom preload, which is what lets the JSONL
 * stream link run here.
 */

const SCRAPE_SECRET = "scrape-me";
const ANONYMOUS_MAX = 4;

const operations = {
  listTags: operation({
    query: `query ListTags($minId: Int!) {
      tags: ${fieldName("pg", "app", "tags")}(where: { id: { gte: $minId } }, orderBy: [{ id: ASC }]) { id }
    }`,
    input: z.object({ minId: z.number().default(1) }),
    output: z.object({ tags: z.array(z.object({ id: z.number() })) }),
    rest: { path: "/tags" },
  }),
  addTag: operation({
    input: z.object({ name: z.string() }),
    output: z.object({ name: z.string() }),
    rest: { path: "/tags", method: "POST" },
    handler: async (_options, { name }) => ({ name }),
  }),
  adminOnly: operation({
    output: z.string(),
    rest: { path: "/admin-only" },
    handler: async () => "for the superadmin role",
  }),
};

type Router = TRPCRouterOf<{ operations: typeof operations }>;

type Span = { spanId: string; parentSpanId?: string; name: string };

const spansIn = (body: string): Span[] =>
  (
    JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }
  ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));

describe.skipIf(!integrationEnabled)("tRPC surface", () => {
  let started: StartedServer;
  let redis: RedisClient;
  let sink: ReturnType<typeof Bun.serve>;
  const bodies: string[] = [];
  let requests = 0;

  const url = (path = "") => `http://localhost:${started.context.server.port}/trpc${path}`;
  const admin = () => ({ "x-admin-secret": process.env["ADMIN_SECRET"]! });

  // Counts the HTTP requests the client sends: a batch is one.
  const clientFor = (stream: boolean, headers: Record<string, string> = {}) => {
    const options = {
      url: url(),
      maxItems: 10,
      headers,
      fetch: (input: RequestInfo | URL | string, init?: RequestInit) => {
        requests++;
        return fetch(input, init);
      },
    };

    return createTRPCClient<Router>({
      links: [stream ? httpBatchStreamLink(options) : httpBatchLink(options)],
    });
  };

  beforeAll(async () => {
    redis = new RedisClient(REDIS_URL);
    sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.text());
        return new Response("{}", { status: 200 });
      },
    });

    started = await startServer({
      engine: "pg",
      config: {
        auth: {
          enabled: false,
          database: "",
          permissions: {
            anonymous: {
              tables: "ALL",
              storedProcedures: "ALL",
              operations: ["listTags", "addTag"],
            },
          },
        },
        operations,
      },
      env: {
        trpc: { enabled: true, endpoint: "/trpc", maxBatchSize: 10 },
        // RATE_LIMIT_STORE=redis: the Lua bucket, not the memory one.
        rateLimit: {
          max: 50,
          anonymousMax: ANONYMOUS_MAX,
          windowMs: 60_000,
          trustProxy: false,
          store: "redis",
        },
        metrics: {
          enabled: true,
          endpoint: "/metrics",
          secrets: [SCRAPE_SECRET],
          maxOperationLabels: 200,
        },
        tracing: {
          enabled: true,
          endpoint: `http://localhost:${sink.port}`,
          headers: "",
          serviceName: "graphoria",
          sampleRatio: 1,
        },
      },
    });
  });

  afterAll(async () => {
    await started?.stop();
    await sink?.stop(true);
    redis?.close();
  });

  // Buckets outlive a run, and the anonymous key is the same address every
  // time, so a leftover bucket would decide the next test's result.
  beforeEach(async () => {
    for (const key of await redis.keys("rl:*")) await redis.del(key);
    requests = 0;
  });

  it("answers a typed query and a typed mutation", async () => {
    const client = clientFor(false);

    const all: { tags: { id: number }[] } = await client.listTags.query({});
    const fromFour = await client.listTags.query({ minId: 4 });
    const added: { name: string } = await client.addTag.mutate({ name: "six" });

    expect(all.tags.map((tag) => tag.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fromFour).toEqual({ tags: [{ id: 4 }, { id: 5 }] });
    expect(added).toEqual({ name: "six" });
  });

  it("streams the calls of one tick as one batch over httpBatchStreamLink", async () => {
    const client = clientFor(true);

    const results = await Promise.all([
      client.listTags.query({ minId: 4 }),
      client.listTags.query({ minId: 5 }),
    ]);

    expect(results).toEqual([{ tags: [{ id: 4 }, { id: 5 }] }, { tags: [{ id: 5 }] }]);
    expect(requests).toBe(1);
  });

  it("answers NOT_FOUND for an operation the caller's role lacks, and serves it to the admin secret", async () => {
    const error = await clientFor(false)
      .adminOnly.query()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TRPCClientError);
    expect((error as TRPCClientError<Router>).data?.code).toBe("NOT_FOUND");
    expect(await clientFor(false, admin()).adminOnly.query()).toBe("for the superadmin role");
  });

  it("answers TOO_MANY_REQUESTS past the ceiling, with Retry-After on a stream's head too", async () => {
    const input = encodeURIComponent(JSON.stringify({ minId: 5 }));
    for (let i = 0; i < ANONYMOUS_MAX; i++) {
      expect((await fetch(url(`/listTags?input=${input}`))).status).toBe(200);
    }

    const limited = await fetch(url(`/listTags?input=${input}`));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await limited.json()).error.data.code).toBe("TOO_MANY_REQUESTS");

    const stream = await fetch(
      url(
        `/listTags,listTags?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: {}, 1: {} }))}`,
      ),
      { headers: { "trpc-accept": "application/jsonl" } },
    );
    expect(stream.status).toBe(200);
    expect(Number(stream.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await stream.text()).toContain("TOO_MANY_REQUESTS");

    expect(
      await clientFor(true)
        .listTags.query({})
        .catch((caught: TRPCClientError<Router>) => caught.data?.code),
    ).toBe("TOO_MANY_REQUESTS");
  });

  it("answers a preflight and sends the CORS headers REST sends", async () => {
    const preflight = await fetch(url("/listTags"), { method: "OPTIONS" });
    const answer = await fetch(url(`/listTags?input=${encodeURIComponent("{}")}`));

    expect([preflight.status, await preflight.text()]).toEqual([200, ""]);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("counts its requests under route=trpc and traces each as GET trpc", async () => {
    bodies.length = 0;

    await clientFor(false).listTags.query({ minId: 5 });

    await flushSpans();
    const spans = bodies.flatMap(spansIn);
    const http = spans.find((span) => span.name === "GET trpc");
    const operationSpan = spans.find((span) => span.name === "query ListTags");
    expect(http?.parentSpanId).toBeUndefined();
    expect(operationSpan?.parentSpanId).toBe(http!.spanId);

    const scrape = await fetch(`http://localhost:${started.context.server.port}/metrics`, {
      headers: { "x-admin-secret": SCRAPE_SECRET },
    });
    expect(await scrape.text()).toContain(
      'graphoria_http_requests_total{method="GET",route="trpc",status="200"}',
    );
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { buildSchema } from "graphql";
import pino from "pino";
import { z } from "zod";

import type { CacheStore } from "../src/singletons/cache/types";
import type { Summary } from "./stats";

import { configureLogging, logger } from "../src/logging";
import { benchmark } from "../src/utils/benchmark";
import { summarize } from "./stats";

/**
 * Times the REST cache hit and miss paths in-process, through
 * `handleRESTRequestFactory` with a stubbed query, and writes `<out>.json` and
 * `<out>.md`.
 *
 *   bun run packages/server/bench/cacheSerialize.ts --out=<path prefix>
 *   … --store=redis                       needs the docker-compose.test.yml stack
 *   … --iterations=20000 --warmup=20000   the defaults
 */

// `singletons/env` parses process.env when the factory is first imported.
process.env.ADMIN_SECRET ??= "bench-admin-secret";
process.env.JWT_SECRET ??= "bench-jwt-secret";

export const OPERATIONS = {
  hit: "cacheSerializeHit",
  hitLarge: "cacheSerializeHitLarge",
  miss: "cacheSerializeMiss",
  concurrent: "cacheSerializeConcurrent",
} as const;

export type Store = "memory" | "redis";

export type Scenario = {
  name: string;
  run: () => Promise<unknown>;
  /** Set on the cached scenarios: how often the query ran, and what each request must be. */
  cache?: {
    /** Present when every request must be a hit/miss; absent = executions are recorded, never asserted. */
    expect?: "hit" | "miss";
    executions: () => number;
  };
};

const SMALL = { ping: true };
const LARGE = {
  ping: true,
  rows: Array.from({ length: 64 }, (_, index) => ({
    id: index,
    title: `row ${index}`,
    completed: index % 2 === 0,
  })),
};
const LARGE_ENVELOPE = { data: LARGE };
const LARGE_TEXT = JSON.stringify(LARGE_ENVELOPE);

const fakeReq = { method: "GET" } as never;

/**
 * The store each cached scenario runs against is the `CACHE_STORE` the env
 * singleton parsed; `store` only picks the suite. `main` sets the variable first.
 */
export const buildScenarios = async (store: Store): Promise<Scenario[]> => {
  const { handleRESTRequestFactory } =
    await import("../src/configuration/rest/handleRESTRequestFactory");
  const { getCache } = await import("../src/singletons/cache");

  const cached = async (
    name: string,
    operation: string,
    data: unknown,
    expect: "hit" | "miss",
    ttl = 600_000,
    parallel = 1,
  ): Promise<Scenario> => {
    let executions = 0;

    const factory = handleRESTRequestFactory(
      {
        operations: {
          [operation]: {
            query: "query { ping }",
            rest:
              expect === "miss"
                ? { path: "/q", method: "GET", queryParams: z.object({ i: z.string() }) }
                : { path: "/q", method: "GET" },
            cache: { ttl, max: 100 },
          },
        },
        remoteRESTApis: [],
        queriesMap: {},
        getResolverSource: () => undefined,
        typeDefs: "",
        schema: buildSchema("type Query { ping: Boolean }"),
        introspection: null,
      } as never,
      {
        handler: async () => ({ data }),
        operatorQuery: async () => {
          executions += 1;
          return { data };
        },
        hasErrors: () => ({ hasErrors: false, errors: [] }),
      } as never,
    );

    // Redis keeps entries across runs: start from an empty store, so the first
    // request of a hit scenario is its only miss and a miss scenario never hits.
    await getCache(operation)!.clear();

    const url = new URL("http://x/q");
    let request = 0;

    const miss = () => {
      request += 1;
      const fresh = new URL(`http://x/q?i=${request}`);
      return parallel === 1
        ? factory.handler(fresh, "/q", "GET", fakeReq)
        : Promise.all(
            Array.from({ length: parallel }, () => factory.handler(fresh, "/q", "GET", fakeReq)),
          );
    };

    return {
      name,
      run: expect === "miss" ? miss : () => factory.handler(url, "/q", "GET", fakeReq),
      cache: {
        // The parallel miss count is the stampede size being measured: record it, never assert it.
        ...(parallel === 1 ? { expect } : {}),
        executions: () => executions,
      },
    };
  };

  const dueMembers = (name: string, operation: string): Scenario => {
    let store: CacheStore | undefined;
    let request = 0;

    // Built on the first run(): listing scenario names in the unit tests stays
    // offline. TTL 100 ms rounds up to a 1 s expiry; the sleep lands past it.
    const buildStore = async (): Promise<CacheStore> => {
      const { RedisCacheStore } = await import("../src/singletons/cache/redisCacheStore");
      const built = new RedisCacheStore(`${operation}-${crypto.randomUUID()}`, 100);
      await built.clear();
      for (let index = 0; index < 100; index += 1) {
        await built.set(`key-${index}`, `value-${index}`);
      }
      await Bun.sleep(1_200);
      return built;
    };

    return {
      name,
      run: async () => {
        store ??= await buildStore();
        request += 1;
        await store.set(`key-${100 + request}`, "value");
      },
    };
  };

  if (store === "redis") {
    return [
      await cached("redis-hit", OPERATIONS.hitLarge, LARGE, "hit"),
      await cached("redis-miss", OPERATIONS.miss, LARGE, "miss"),
      dueMembers("redis-due-members", "cacheSerializeDueMembers"),
      await cached("redis-concurrent", OPERATIONS.concurrent, LARGE, "miss", 600_000, 50),
    ];
  }

  return [
    await cached("memory-hit", OPERATIONS.hit, SMALL, "hit"),
    await cached("memory-hit-large", OPERATIONS.hitLarge, LARGE, "hit"),
    await cached("memory-miss", OPERATIONS.miss, LARGE, "miss"),
    { name: "reference-stringify", run: async () => JSON.stringify(LARGE_ENVELOPE) },
    { name: "reference-parse", run: async () => JSON.parse(LARGE_TEXT) },
  ];
};

const measure = async (run: () => Promise<unknown>, iterations: number, warmup: number) => {
  for (let index = 0; index < warmup; index += 1) await run();

  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = Bun.nanoseconds();
    await run();
    samples.push((Bun.nanoseconds() - started) / 1e6);
  }

  return samples;
};

type Result = Summary & { name: string; batchMs: number; executions?: number };

const flag = (name: string) =>
  Bun.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];

const us = (ms: number) => (ms * 1000).toFixed(2);

const renderMarkdown = (
  store: Store,
  iterations: number,
  warmup: number,
  recordedAt: string,
  results: Result[],
) => `# Cache serialize micro-benchmark — ${store}

Generated by \`bun run packages/server/bench/cacheSerialize.ts --store=${store} --out=<path prefix>\`. Do not edit by hand.

- Recorded: ${recordedAt}
- Iterations: ${iterations} measured, ${warmup} discarded as warmup
- Bun ${Bun.version}

| scenario | p50 µs | p95 µs | p99 µs | mean µs | batch ms | executions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${results
  .map(
    (result) =>
      `| \`${result.name}\` | ${us(result.p50)} | ${us(result.p95)} | ${us(result.p99)} | ${us(result.mean)} | ${result.batchMs.toFixed(1)} | ${result.executions ?? "-"} |`,
  )
  .join("\n")}

\`batch ms\` is the duration \`benchmark()\` (\`src/utils/benchmark.ts\`) logged for the
scenario's whole batch, warmup included. \`executions\` is how many times the stubbed
query ran over the whole batch; \`-\` for scenarios that run no query.
`;

const main = async () => {
  const store = (flag("store") ?? "memory") as Store;
  const iterations = Number(flag("iterations") ?? 20_000);
  const warmup = Number(flag("warmup") ?? 20_000);
  const out = flag("out");

  if (store !== "memory" && store !== "redis") {
    throw new Error(`--store must be memory or redis, got ${store}`);
  }
  if (!out) throw new Error("--out=<path prefix> is required");

  // The REST handler logs every request at debug. Keep the root at info so
  // that cost stays out of the samples, raise `benchmark` alone, and keep the
  // duration it logs for the report.
  let batchMs = 0;
  configureLogging(
    pino(
      { level: "info" },
      {
        write: (line: string) => {
          const entry = JSON.parse(line) as { component?: string; durationMs?: number };
          if (entry.component === "benchmark") batchMs = entry.durationMs ?? 0;
          process.stdout.write(line);
        },
      },
    ),
  );
  logger("benchmark").level = "debug";

  process.env.CACHE_STORE = store;
  if (store === "redis") process.env.REDIS_URL ??= "redis://127.0.0.1:56379";

  const results: Result[] = [];
  try {
    for (const scenario of await buildScenarios(store)) {
      const samples = await benchmark(() => measure(scenario.run, iterations, warmup));

      const executed = scenario.cache ? scenario.cache.executions() : undefined;
      if (scenario.cache?.expect) {
        const wanted = scenario.cache.expect === "hit" ? 1 : warmup + iterations;
        if (executed !== wanted) {
          throw new Error(
            `${scenario.name}: the query ran ${executed} times, expected ${wanted} — the cache did not ${scenario.cache.expect}`,
          );
        }
      }

      const summary = summarize(samples);
      results.push({
        ...summary,
        name: scenario.name,
        batchMs,
        ...(executed === undefined ? {} : { executions: executed }),
      });
      console.log(
        `${scenario.name}: p50 ${us(summary.p50)} µs  p95 ${us(summary.p95)} µs  batch ${batchMs.toFixed(1)} ms`,
      );
    }
  } finally {
    if (store === "redis") {
      (await import("../src/singletons/cache/redisClient")).closeCacheRedisClient();
    }
  }

  const recordedAt = new Date().toISOString();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    `${out}.json`,
    `${JSON.stringify({ engine: "cache-serialize", store, iterations, warmup, recordedAt, bun: Bun.version, scenarios: results }, null, 2)}\n`,
  );
  await writeFile(`${out}.md`, renderMarkdown(store, iterations, warmup, recordedAt, results));

  console.log(`\nwrote ${out}.json and ${out}.md`);
};

if (import.meta.main) await main();

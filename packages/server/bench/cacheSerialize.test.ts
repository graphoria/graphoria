import { beforeAll, describe, expect, it } from "bun:test";

// `singletons/env` parses process.env at module load and the scenarios pull it
// in, so the variables are set before the dynamic import below.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.CACHE_STORE = "memory";

let buildScenarios: typeof import("./cacheSerialize").buildScenarios;

beforeAll(async () => {
  ({ buildScenarios } = await import("./cacheSerialize"));
});

const scenario = async (name: string) =>
  (await buildScenarios("memory")).find((candidate) => candidate.name === name)!;

describe("scenario suite", () => {
  it("covers the memory hits, the miss and the two references", async () => {
    expect((await buildScenarios("memory")).map((candidate) => candidate.name)).toEqual([
      "memory-hit",
      "memory-hit-large",
      "memory-miss",
      "reference-stringify",
      "reference-parse",
    ]);
  });

  it("covers the redis scenarios", async () => {
    expect((await buildScenarios("redis")).map((candidate) => candidate.name)).toEqual([
      "redis-hit",
      "redis-miss",
      "redis-due-members",
      "redis-concurrent",
    ]);
  });
});

describe("benchmark honesty", () => {
  it("memory-hit runs the query once and serves every later request from the cache", async () => {
    const hit = await scenario("memory-hit");
    for (let index = 0; index < 50; index += 1) await hit.run();

    expect(hit.cache!.executions()).toBe(1);
  });

  it("memory-hit-large serves its own payload, not memory-hit's", async () => {
    const scenarios = await buildScenarios("memory");
    const hit = scenarios.find((candidate) => candidate.name === "memory-hit")!;
    const large = scenarios.find((candidate) => candidate.name === "memory-hit-large")!;

    await hit.run();
    await large.run();
    const body = await ((await large.run()) as Response).text();

    expect(large.cache!.executions()).toBe(1);
    expect(body.length).toBeGreaterThan(2_000);
  });

  it("memory-miss runs the query on every request", async () => {
    const miss = await scenario("memory-miss");
    for (let index = 0; index < 20; index += 1) await miss.run();

    expect(miss.cache!.executions()).toBe(20);
  });

  it("redis-concurrent serves every parallel request with the same payload", async () => {
    const concurrent = (await buildScenarios("redis")).find(
      (candidate) => candidate.name === "redis-concurrent",
    )!;

    const responses = (await concurrent.run()) as Response[];

    expect(responses).toHaveLength(50);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(new Set(bodies).size).toBe(1);
  });
});

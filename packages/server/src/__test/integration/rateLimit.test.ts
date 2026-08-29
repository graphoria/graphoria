import { RedisClient } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { StartedServer } from "./harness";

import { INTEGRATION_ENABLED, REDIS_URL } from "./config";
import { startServer } from "./harness";

/**
 * The limiter is engine-agnostic — it never reaches the query builder — so one
 * engine proves it. Redis is the interesting half: the suite runs with
 * CACHE_STORE=redis, so these exercise the Lua bucket, not the memory one.
 */
const describeIf = INTEGRATION_ENABLED ? describe : describe.skip;

const WINDOW_MS = 60_000;
const ANONYMOUS_MAX = 3;

const rateLimit = {
  max: 20,
  anonymousMax: ANONYMOUS_MAX,
  windowMs: WINDOW_MS,
  trustProxy: false,
};

const QUERY = "{ __typename }";

describeIf("rate limiting", () => {
  let started: StartedServer;
  let redis: RedisClient;

  beforeAll(async () => {
    redis = new RedisClient(REDIS_URL);
    started = await startServer({ engine: "pg", env: { rateLimit } });
  });

  afterAll(async () => {
    await started.stop();
    redis.close();
  });

  // Buckets outlive a test run, and the anonymous key is the same address every
  // time, so a leftover bucket would decide the next run's result.
  beforeEach(async () => {
    for (const key of await redis.keys("rl:*")) await redis.del(key);
  });

  const post = (options?: { admin?: boolean }) => started.context.gqlRaw(QUERY, undefined, options);

  it("serves the anonymous caller up to the ceiling", async () => {
    for (let i = 0; i < ANONYMOUS_MAX; i++) expect((await post()).status).toBe(200);
  });

  it("answers 429 once the anonymous ceiling is spent", async () => {
    for (let i = 0; i < ANONYMOUS_MAX; i++) await post();

    expect((await post()).status).toBe(429);
  });

  it("states a Retry-After a client can parse", async () => {
    for (let i = 0; i < ANONYMOUS_MAX; i++) await post();
    const response = await post();

    const retryAfter = Number(response.headers.get("Retry-After"));

    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("gives an authenticated caller a higher ceiling under the same load", async () => {
    for (let i = 0; i < ANONYMOUS_MAX + 2; i++) await post();

    expect((await post()).status).toBe(429);
    expect((await post({ admin: true })).status).toBe(200);
  });

  it("counts the admin secret rather than exempting it", async () => {
    for (let i = 0; i < rateLimit.max; i++) await post({ admin: true });

    expect((await post({ admin: true })).status).toBe(429);
  });

  it("shares one budget between two servers on the same redis", async () => {
    const second = await startServer({ engine: "pg", env: { rateLimit }, skipSeed: true });

    try {
      for (let i = 0; i < ANONYMOUS_MAX; i++) await post();

      expect((await second.context.gqlRaw(QUERY)).status).toBe(429);
    } finally {
      await second.stop();
    }
  });
});

describeIf("rate limiting, as shipped", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startServer({ engine: "pg" });
  });

  afterAll(async () => {
    await started.stop();
  });

  // Asserted so that turning the limit on by default fails a test rather than
  // silently changing every deployment's behaviour.
  it("is off when neither ceiling is configured", async () => {
    for (let i = 0; i < 25; i++) expect((await started.context.gqlRaw(QUERY)).status).toBe(200);
  });
});

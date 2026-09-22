import { describe, expect, it } from "bun:test";

import type { HealthCheck } from "./health";

import { createHealthRoutes } from "./health";

const BASE = "/health";

const routesFor = (checks: HealthCheck[], timeoutMs = 50) =>
  createHealthRoutes({ basePath: BASE, checks: () => checks, timeoutMs });

const call = async (routes: ReturnType<typeof routesFor>, path: string) => {
  const response = await routes[path]!();
  return { status: response.status, body: await response.json() };
};

describe("createHealthRoutes", () => {
  it("mounts live and ready under the base path", () => {
    expect(Object.keys(routesFor([])).sort()).toEqual([`${BASE}/live`, `${BASE}/ready`]);
  });

  it("reports live without running a single check", async () => {
    let probed = false;
    const routes = routesFor([
      {
        kind: "database",
        name: "main",
        probe: () => {
          probed = true;
          return false;
        },
      },
    ]);

    expect(await call(routes, `${BASE}/live`)).toEqual({ status: 200, body: { status: "ok" } });
    expect(probed).toBe(false);
  });

  it("is ready when every check passes", async () => {
    const routes = routesFor([
      { kind: "database", name: "main", probe: async () => true },
      { kind: "redis", probe: () => true },
    ]);

    expect(await call(routes, `${BASE}/ready`)).toEqual({
      status: 200,
      body: {
        status: "ok",
        checks: [
          { kind: "database", name: "main", ok: true },
          { kind: "redis", ok: true },
        ],
      },
    });
  });

  it("is ready with nothing to check", async () => {
    expect(await call(routesFor([]), `${BASE}/ready`)).toEqual({
      status: 200,
      body: { status: "ok", checks: [] },
    });
  });

  it("is unavailable when a check reports false", async () => {
    const routes = routesFor([
      { kind: "database", name: "main", probe: async () => true },
      { kind: "rabbitmq", name: "events", probe: () => false },
    ]);

    expect(await call(routes, `${BASE}/ready`)).toEqual({
      status: 503,
      body: {
        status: "unavailable",
        checks: [
          { kind: "database", name: "main", ok: true },
          { kind: "rabbitmq", name: "events", ok: false },
        ],
      },
    });
  });

  it("is unavailable when a check throws, and keeps the error out of the body", async () => {
    const routes = routesFor([
      {
        kind: "database",
        name: "main",
        probe: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
        },
      },
    ]);

    const { status, body } = await call(routes, `${BASE}/ready`);

    expect(status).toBe(503);
    expect(body).toEqual({
      status: "unavailable",
      checks: [{ kind: "database", name: "main", ok: false }],
    });
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("is unavailable when a check outlasts the timeout", async () => {
    const routes = routesFor([{ kind: "redis", probe: () => new Promise<boolean>(() => {}) }], 20);

    const started = performance.now();
    const { status, body } = await call(routes, `${BASE}/ready`);

    expect(status).toBe(503);
    expect(body.checks).toEqual([{ kind: "redis", ok: false }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("runs the checks side by side, not one after another", async () => {
    const slow = () => Bun.sleep(40).then(() => true);
    const routes = routesFor(
      [
        { kind: "database", name: "a", probe: slow },
        { kind: "database", name: "b", probe: slow },
        { kind: "database", name: "c", probe: slow },
      ],
      1000,
    );

    const started = performance.now();
    const { status } = await call(routes, `${BASE}/ready`);

    expect(status).toBe(200);
    expect(performance.now() - started).toBeLessThan(110);
  });

  it("reads the checks on every request", async () => {
    let connected = false;
    const routes = createHealthRoutes({
      basePath: BASE,
      checks: () => [{ kind: "kafka", name: "orders", probe: () => connected }],
      timeoutMs: 50,
    });

    expect((await call(routes, `${BASE}/ready`)).status).toBe(503);
    connected = true;
    expect((await call(routes, `${BASE}/ready`)).status).toBe(200);
  });
});

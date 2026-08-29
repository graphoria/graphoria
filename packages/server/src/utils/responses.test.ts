import { describe, expect, it } from "bun:test";

import { ClientResponse, S200, S400, S401, S404, S429, S500 } from "./responses";

describe("ClientResponse", () => {
  it("serializes body as JSON", async () => {
    const res = new ClientResponse({ a: 1 });
    expect(await res.json()).toEqual({ a: 1 });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("sends a null body when none provided", async () => {
    const res = new ClientResponse();
    expect(res.body).toBeNull();
  });

  it("sets permissive CORS headers", () => {
    const res = new ClientResponse({});
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("*");
  });
});

describe("status helpers", () => {
  const cases: Array<[string, new (body?: object | null) => Response, number]> = [
    ["S200", S200, 200],
    ["S400", S400, 400],
    ["S401", S401, 401],
    ["S404", S404, 404],
    ["S500", S500, 500],
  ];

  for (const [name, Cls, status] of cases) {
    it(`${name} sets status ${status}`, () => {
      const res = new Cls({ ok: true });
      expect(res.status).toBe(status);
    });
  }

  it("preserves the body on a status helper", async () => {
    const res = new S401({ errors: ["bad"] });
    expect(await res.json()).toEqual({ errors: ["bad"] });
  });
});

describe("S429", () => {
  it("sets status 429", () => {
    expect(new S429(1000).status).toBe(429);
  });

  it("states the wait in whole seconds, rounded up", () => {
    expect(new S429(1500).headers.get("Retry-After")).toBe("2");
  });

  it("never tells a caller to retry immediately", () => {
    expect(new S429(0).headers.get("Retry-After")).toBe("1");
  });

  it("says only that the limit was exceeded", async () => {
    expect(await new S429(1000).json()).toEqual({
      errors: [{ message: "Rate limit exceeded" }],
    });
  });

  it("leaks nothing about the configured ceiling", () => {
    const res = new S429(1000);

    expect([...res.headers.keys()].filter((h) => h.startsWith("x-ratelimit"))).toEqual([]);
  });
});

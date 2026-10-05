import { describe, expect, it } from "bun:test";

import { ClientResponse, S200, S200Serialized, S304, S400, S401, S404, S429, S500 } from "./responses";

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

describe("S200Serialized", () => {
  it("sends pre-serialized JSON text as is", async () => {
    const res = new S200Serialized('{"a":1}');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"a":1}');
  });

  it("sets the same headers as S200", () => {
    expect([...new S200Serialized("{}").headers]).toEqual([...new S200({}).headers]);
  });

  it("sends an empty text as an empty body", async () => {
    expect(await new S200Serialized("").text()).toBe("");
  });

  it("sets the ETag when one is given", async () => {
    const res = new S200Serialized("x", '"abc"');

    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe("x");
  });
});

describe("S304", () => {
  it("has status 304, CORS headers only, no content type, and an empty body", async () => {
    const res = new S304();

    expect(res.status).toBe(304);
    expect(res.headers.get("Content-Type")).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("*");
  });
});

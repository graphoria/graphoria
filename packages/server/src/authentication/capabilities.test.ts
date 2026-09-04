import { describe, expect, it } from "bun:test";

import type { Env } from "../types/env";

import { createCapabilityAuthorizer } from "./capabilities";

const env = {
  admin: { secrets: ["admin-new", "admin-old"], header: "x-admin-secret" },
  console: { readSecrets: ["read"], writeSecrets: ["write"] },
  ai: { secrets: ["ai"], mcp: { secrets: ["mcp"] } },
} as unknown as Env;

const withWarnings = () => {
  const warnings: unknown[] = [];
  const authorize = createCapabilityAuthorizer(env, {
    warn: (...args: unknown[]) => {
      warnings.push(args[0]);
    },
  });
  return { authorize, warnings };
};

describe("createCapabilityAuthorizer", () => {
  it("grants every capability to the admin secret, as the superset", () => {
    const { authorize } = withWarnings();
    for (const capability of ["console:read", "console:write", "ai", "mcp"] as const) {
      expect(authorize("admin-new", capability)).toEqual({ superset: true });
    }
  });

  it("grants the superset to a previous admin secret too", () => {
    const { authorize } = withWarnings();
    expect(authorize("admin-old", "mcp")).toEqual({ superset: true });
  });

  it("warns once per superset use, naming the capability a scoped credential would have covered", () => {
    const { authorize, warnings } = withWarnings();
    authorize("admin-new", "ai");
    expect(warnings).toEqual([{ capability: "ai" }]);
  });

  it("does not warn when a scoped credential is used", () => {
    const { authorize, warnings } = withWarnings();
    authorize("ai", "ai");
    authorize("nope", "ai");
    expect(warnings).toEqual([]);
  });

  it("grants a scoped credential only its own capability", () => {
    const { authorize } = withWarnings();
    expect(authorize("ai", "ai")).toEqual({ superset: false });
    expect(authorize("ai", "mcp")).toBeNull();
    expect(authorize("ai", "console:read")).toBeNull();
    expect(authorize("ai", "console:write")).toBeNull();
    expect(authorize("mcp", "mcp")).toEqual({ superset: false });
    expect(authorize("mcp", "ai")).toBeNull();
  });

  it("grants console read but not write to the read secret", () => {
    const { authorize } = withWarnings();
    expect(authorize("read", "console:read")).toEqual({ superset: false });
    expect(authorize("read", "console:write")).toBeNull();
    expect(authorize("read", "ai")).toBeNull();
    expect(authorize("read", "mcp")).toBeNull();
  });

  it("grants console read and write to the write secret", () => {
    const { authorize } = withWarnings();
    expect(authorize("write", "console:read")).toEqual({ superset: false });
    expect(authorize("write", "console:write")).toEqual({ superset: false });
    expect(authorize("write", "ai")).toBeNull();
  });

  it("rejects a missing, empty or unknown candidate", () => {
    const { authorize } = withWarnings();
    expect(authorize(null, "ai")).toBeNull();
    expect(authorize("", "ai")).toBeNull();
    expect(authorize("unknown", "console:read")).toBeNull();
  });

  it("never matches an unset scoped credential, even against an empty header", () => {
    const authorize = createCapabilityAuthorizer(
      {
        admin: { secrets: ["admin"], header: "x-admin-secret" },
        console: { readSecrets: [], writeSecrets: [] },
        ai: { secrets: [], mcp: { secrets: [] } },
      } as unknown as Env,
      { warn: () => {} },
    );
    expect(authorize("", "console:read")).toBeNull();
    expect(authorize("", "mcp")).toBeNull();
  });
});

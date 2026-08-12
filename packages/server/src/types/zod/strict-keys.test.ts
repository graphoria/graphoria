import { describe, expect, it } from "bun:test";

import { ConfigurationZod } from "./configuration";

/**
 * Unknown keys in the configuration must be rejected, not ignored. A typo in a
 * permission filter that silently parses is a security bug: the role ends up
 * with no filter at all rather than a broken one.
 *
 * These cases also pin down two things that are easy to lose by accident:
 * strictness surviving `.extend()` (the queue discriminated union) and
 * strictness applying inside `z.record` values (per-role permissions).
 */

const minimalConfig = {
  name: "test",
  version: "1.0.0",
};

const database = {
  name: "default",
  enabled: true,
  type: "pg" as const,
  connection: {
    host: "localhost",
    port: 5432,
    user: "u",
    password: "p",
    database: "d",
  },
};

const unrecognized = (result: ReturnType<typeof ConfigurationZod.safeParse>) => {
  if (result.success) throw new Error("expected parse to fail");
  return result.error.issues.filter((issue) => issue.code === "unrecognized_keys");
};

describe("configuration strictness", () => {
  it("accepts a minimal valid configuration", () => {
    expect(ConfigurationZod.safeParse(minimalConfig).success).toBe(true);
  });

  it("rejects an unknown top-level key and names it", () => {
    const issues = unrecognized(
      ConfigurationZod.safeParse({ ...minimalConfig, databses: [database] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ keys: ["databses"], path: [] });
  });

  it("rejects an unknown key inside a database connection and reports its path", () => {
    const issues = unrecognized(
      ConfigurationZod.safeParse({
        ...minimalConfig,
        databases: [{ ...database, connection: { ...database.connection, hostname: "localhost" } }],
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      keys: ["hostname"],
      path: ["databases", 0, "connection"],
    });
  });

  it("rejects an unknown key inside a role permission", () => {
    const issues = unrecognized(
      ConfigurationZod.safeParse({
        ...minimalConfig,
        databases: [database],
        auth: {
          enabled: true,
          database: "default",
          permissions: {
            user: { tables: "ALL", storedProcedure: ["sp_x"] },
          },
        },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      keys: ["storedProcedure"],
      path: ["auth", "permissions", "user"],
    });
  });

  // `tables` is a union, so the strictness failure surfaces as a nested
  // invalid_union issue rather than a top-level unrecognized_keys one. The
  // parse still fails closed, which is the property that matters here.
  it("rejects an unknown key inside a table permission", () => {
    const result = ConfigurationZod.safeParse({
      ...minimalConfig,
      databases: [database],
      auth: {
        enabled: true,
        database: "default",
        permissions: {
          user: { tables: { orders: { columns: "ALL", filters: { user_id: { eq: "1" } } } } },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("filters");
  });

  it("rejects an unknown key in a queue config, so .extend() keeps strictness", () => {
    const issues = unrecognized(
      ConfigurationZod.safeParse({
        ...minimalConfig,
        queues: [
          {
            name: "events",
            type: "rabbitmq",
            connection: "amqp://localhost:5672",
            publishers: {},
            subscriber: {},
          },
        ],
      }),
    );

    expect(issues.some((issue) => issue.keys.includes("subscriber"))).toBe(true);
  });

  it("rejects an unknown key in an operation config", () => {
    const issues = unrecognized(
      ConfigurationZod.safeParse({
        ...minimalConfig,
        operations: {
          listUsers: { query: "query { users { id } }", restt: { path: "/users" } },
        },
      }),
    );

    expect(issues.some((issue) => issue.keys.includes("restt"))).toBe(true);
  });
});

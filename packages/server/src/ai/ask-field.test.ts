process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";

const { getSchema } = await import("../configuration/getSchemas");
const { StoreMSSQL } = await import("../__test/dataset/store");
const { EntitySource } = await import("../types/resolver");

const entities = {
  tables: StoreMSSQL.tables,
  storedProcedures: StoreMSSQL.storedProcedures,
  queues: [],
  operations: {},
  remoteSchemas: [],
  remoteREST: [],
};

describe("ask GraphQL field gating", () => {
  it("adds the ask query field when includeAI is true", () => {
    const role = getSchema(entities, null, null, true);
    expect(role.typeDefs).toContain("ask(prompt: String!): String!");
    expect(role.getResolverSource("ask")).toBe(EntitySource.AI);
  });

  it("omits the ask query field when includeAI is false", () => {
    const role = getSchema(entities, null, null, false);
    expect(role.typeDefs).not.toContain("ask(prompt");
    expect(role.getResolverSource("ask")).toBeUndefined();
  });
});

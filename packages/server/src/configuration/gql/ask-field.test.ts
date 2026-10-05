process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { describe, expect, it } from "bun:test";
import type { Auth } from "../../types/configuration";

const { getSchema, getSchemas } = await import("../../configuration/getSchemas");
const { StoreMSSQL } = await import("../../__test/dataset/store");
const { EntitySource } = await import("../../types/resolver");

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

describe("ask field per role", () => {
  const superadminGql = getSchema(entities).handlers.gql;
  const auth = { enabled: false } as Auth;

  it("compiles ask into the roles granted ai only", () => {
    const schemas = getSchemas(
      { analyst: { ...entities, ai: true }, viewer: entities },
      auth,
      superadminGql,
      true,
    );

    expect(schemas.analyst!.typeDefs).toContain("ask(prompt: String!): String!");
    expect(schemas.viewer!.typeDefs).not.toContain("ask(prompt");
  });

  it("compiles ask into no role while the GraphQL surface is off", () => {
    const schemas = getSchemas({ analyst: { ...entities, ai: true } }, auth, superadminGql, false);

    expect(schemas.analyst!.typeDefs).not.toContain("ask(prompt");
  });
});

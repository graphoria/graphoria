process.env.ADMIN_SECRET ??= "test-admin";
process.env.JWT_SECRET ??= "test-jwt";

import { beforeEach, describe, expect, it } from "bun:test";

const { getSchema } = await import("../configuration/getSchemas");
const { StoreMSSQL } = await import("../__test/dataset/store");
const { instantiateAI, getAgent, resetAI } = await import("./ai");

const buildRole = () =>
  getSchema({
    tables: StoreMSSQL.tables,
    storedProcedures: StoreMSSQL.storedProcedures,
    queues: [],
    operations: {},
    remoteSchemas: [],
    remoteREST: [],
  });

describe("AI singleton", () => {
  beforeEach(() => resetAI());

  it("getAgent throws before instantiateAI", () => {
    expect(() => getAgent()).toThrow(/not enabled/);
  });

  it("instantiateAI stores a callable agent", () => {
    instantiateAI({ enabled: true, endpoint: "/ai", mcp: { enabled: false } }, buildRole());
    expect(typeof getAgent()).toBe("function");
  });
});

import { describe, expect, it } from "bun:test";

import { genResolverName } from "./genResolverName";

describe("genResolverName", () => {
  it("default field naming", () => {
    expect(genResolverName("dbo", "users", "table", "{schema}_{name}", "pg")).toEqual("dbo_users");
  });

  it("field naming with database name", () => {
    expect(genResolverName("dbo", "users", "table", "{database}_{schema}_{name}", "pg")).toEqual(
      "pg_dbo_users",
    );
  });

  it("custom field naming", () => {
    expect(genResolverName("dbo", "users", "table", "store_{schema}_{name}", "pg")).toEqual(
      "store_dbo_users",
    );
  });
});

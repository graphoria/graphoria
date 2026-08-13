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

  it("sanitises a table name GraphQL cannot spell", () => {
    expect(genResolverName("catalog", "categoría", "table")).toEqual("catalog_categoria");
    expect(genResolverName("catalog", "space name", "table")).toEqual("catalog_space_name");
  });

  it("sanitises the schema name too", () => {
    expect(genResolverName("mi esquema", "users", "table")).toEqual("mi_esquema_users");
  });

  it("sanitises after the suffix is appended", () => {
    expect(
      genResolverName("catalog", "categoría", "table", "{schema}_{name}", "", "aggregate"),
    ).toEqual("catalog_categoria_aggregate");
  });
});

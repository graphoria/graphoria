import { describe, expect, it } from "bun:test";

import { columnFieldName, sanitizeGraphQLName } from "./graphqlName";

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

describe("sanitizeGraphQLName", () => {
  it("leaves an already-valid name untouched", () => {
    // Identity here is what keeps this a non-breaking change: every name that
    // produces a working schema today already matches GRAPHQL_NAME.
    for (const name of ["users", "app_users", "_private", "Table1", "a_1_B"]) {
      expect(sanitizeGraphQLName(name)).toBe(name);
    }
  });

  it("folds diacritics to their base letter rather than dropping them", () => {
    expect(sanitizeGraphQLName("categoría")).toBe("categoria");
    expect(sanitizeGraphQLName("descripción")).toBe("descripcion");
    expect(sanitizeGraphQLName("ÀÉÎÕÜ")).toBe("AEIOU");
  });

  it("replaces every other illegal character with an underscore", () => {
    expect(sanitizeGraphQLName("space name")).toBe("space_name");
    expect(sanitizeGraphQLName("order-items")).toBe("order_items");
    expect(sanitizeGraphQLName("a.b$c")).toBe("a_b_c");
  });

  it("does not collapse runs, so distinct names stay distinct", () => {
    expect(sanitizeGraphQLName("a  b")).toBe("a__b");
    expect(sanitizeGraphQLName("a b")).toBe("a_b");
  });

  it("prefixes a leading digit", () => {
    expect(sanitizeGraphQLName("2024_reports")).toBe("_2024_reports");
  });

  it("never returns an empty name", () => {
    expect(sanitizeGraphQLName("")).toBe("_");
    expect(sanitizeGraphQLName("日本")).toBe("__");
  });

  it("always produces a legal GraphQL name", () => {
    for (const name of ["categoría", "space name", "2024", "", "日本", "a.b$c", "--"]) {
      expect(sanitizeGraphQLName(name)).toMatch(GRAPHQL_NAME);
    }
  });
});

describe("columnFieldName", () => {
  it("uses the fieldName an introspected column carries", () => {
    expect(columnFieldName({ name: "space col", fieldName: "space_col" })).toBe("space_col");
  });

  it("sanitises on the spot for a virtual column, which carries no fieldName", () => {
    expect(columnFieldName({ name: "descripción" })).toBe("descripcion");
    expect(columnFieldName({ name: "full_name" })).toBe("full_name");
  });
});

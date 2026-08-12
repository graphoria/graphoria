import { describe, expect, it } from "bun:test";

import type { VariableDefinition } from "../../../analyzeQuery/types";

import { toMySQLPlaceholders } from "./placeholders";

const vars = (...names: string[]): VariableDefinition[] =>
  names.map((name) => ({ name, type: "String", required: false }));

describe("toMySQLPlaceholders", () => {
  it("rewrites $n to ? and binds values in text order", () => {
    const result = toMySQLPlaceholders(
      "SELECT * FROM `t` WHERE `a` = $2 AND `b` = $1",
      vars("first", "second"),
      { first: "one", second: "two" },
    );

    expect(result.query).toBe("SELECT * FROM `t` WHERE `a` = ? AND `b` = ?");
    expect(result.params).toEqual(["two", "one"]);
  });

  it("binds a repeated placeholder once per occurrence", () => {
    const result = toMySQLPlaceholders("SELECT LPAD($1, $2, $1)", vars("value", "width"), {
      value: "x",
      width: 4,
    });

    expect(result.query).toBe("SELECT LPAD(?, ?, ?)");
    expect(result.params).toEqual(["x", 4, "x"]);
  });

  it("leaves $n inside a string literal alone", () => {
    const result = toMySQLPlaceholders(
      "SELECT * FROM `t` WHERE `kind` = 'price is $1 usd' AND `id` = $1",
      vars("id"),
      { id: 7 },
    );

    expect(result.query).toBe("SELECT * FROM `t` WHERE `kind` = 'price is $1 usd' AND `id` = ?");
    expect(result.params).toEqual([7]);
  });

  it("handles doubled and backslash-escaped quotes inside a literal", () => {
    const result = toMySQLPlaceholders(
      "SELECT 'O''Brien $9', 'back\\\\slash $9', `weird$1col` FROM `t` WHERE `id` = $1",
      vars("id"),
      { id: 1 },
    );

    expect(result.query).toBe(
      "SELECT 'O''Brien $9', 'back\\\\slash $9', `weird$1col` FROM `t` WHERE `id` = ?",
    );
    expect(result.params).toEqual([1]);
  });

  it("passes a statement with no placeholders through untouched", () => {
    const result = toMySQLPlaceholders("SELECT 1", vars("unused"), { unused: "x" });

    expect(result.query).toBe("SELECT 1");
    expect(result.params).toEqual([]);
  });

  it("preserves false and null values rather than dropping them", () => {
    const result = toMySQLPlaceholders("SELECT $1, $2", vars("flag", "empty"), {
      flag: false,
      empty: null,
    });

    expect(result.params).toEqual([false, null]);
  });

  it("throws when a placeholder has no matching variable definition", () => {
    expect(() => toMySQLPlaceholders("SELECT $3", vars("only"), { only: 1 })).toThrow(
      "MySQL query references $3 but only 1 variable is defined",
    );
  });
});

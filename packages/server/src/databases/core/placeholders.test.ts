import { describe, expect, it } from "bun:test";

import type { VariableDefinition } from "../../analyzeQuery/types";

import { compactPlaceholders } from "./placeholders";

const vars = (...names: string[]): VariableDefinition[] =>
  names.map((name) => ({ name, type: "Text", required: false }));

const namesOf = (definitions: VariableDefinition[]) => definitions.map(({ name }) => name);

describe("compactPlaceholders", () => {
  it("drops the definitions a statement never references and closes the gaps", () => {
    const result = compactPlaceholders(
      "SELECT * FROM t WHERE a = $2 AND b = $2 AND c = $3",
      vars("a", "b", "c"),
    );

    expect(result.query).toBe("SELECT * FROM t WHERE a = $1 AND b = $1 AND c = $2");
    expect(namesOf(result.variablesDefinition)).toEqual(["b", "c"]);
  });

  it("closes the gaps around a directive that emits $3 before $1", () => {
    const result = compactPlaceholders("SELECT f($3, $1)", vars("a", "b", "c"));

    expect(result.query).toBe("SELECT f($2, $1)");
    expect(namesOf(result.variablesDefinition)).toEqual(["a", "c"]);
  });

  it("leaves a placeholder inside a string literal alone", () => {
    const result = compactPlaceholders(
      "SELECT * FROM t WHERE kind = 'price is $1 usd' AND id = $2",
      vars("kind", "id"),
    );

    expect(result.query).toBe("SELECT * FROM t WHERE kind = 'price is $1 usd' AND id = $1");
    expect(namesOf(result.variablesDefinition)).toEqual(["id"]);
  });

  it("drops every definition from a statement that references none", () => {
    const result = compactPlaceholders("SELECT 1", vars("unused"));

    expect(result.query).toBe("SELECT 1");
    expect(result.variablesDefinition).toEqual([]);
  });

  it("keeps scanning past a literal that ends in a backslash", () => {
    const result = compactPlaceholders(
      "SELECT * FROM t WHERE name LIKE $1 ESCAPE '\\' AND id = $3",
      vars("pattern", "unused", "id"),
      "sqlite",
    );

    expect(result.query).toBe("SELECT * FROM t WHERE name LIKE $1 ESCAPE '\\' AND id = $2");
    expect(namesOf(result.variablesDefinition)).toEqual(["pattern", "id"]);
  });

  it("renumbers the engine's own placeholder character", () => {
    const result = compactPlaceholders("SELECT * FROM [t] WHERE a = @2", vars("a", "b"), "mssql");

    expect(result.query).toBe("SELECT * FROM [t] WHERE a = @1");
    expect(namesOf(result.variablesDefinition)).toEqual(["b"]);
  });

  it("throws when the statement references a placeholder with no definition", () => {
    expect(() => compactPlaceholders("SELECT $3", vars("only"))).toThrow(
      "Statement references $3 but only 1 variable is defined",
    );
  });
});

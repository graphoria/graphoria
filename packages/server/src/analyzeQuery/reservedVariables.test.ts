import { describe, expect, it } from "bun:test";
import { buildSchema, parse, specifiedRules, validate } from "graphql";

import { reservedVariableNamesRule } from "./reservedVariables";

const schema = buildSchema(`type Query { items(limit: Int): [Int!]! }`);

const errorsOf = (query: string) =>
  validate(schema, parse(query), [...specifiedRules, reservedVariableNamesRule]);

describe("reservedVariableNamesRule", () => {
  it("refuses a variable named like a hoisted literal", () => {
    expect(
      errorsOf(`query Q($static_0: Int) { items(limit: $static_0) }`).map((e) => e.message),
    ).toEqual([
      'Variable "$static_0" uses a reserved name: static_N names are generated for literals.',
    ]);
  });

  it.each(["static", "static_", "static_a", "my_static_0", "Static_0"])("allows $%s", (name) => {
    expect(errorsOf(`query Q($${name}: Int) { items(limit: $${name}) }`)).toEqual([]);
  });
});

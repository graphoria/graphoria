import { describe, expect, it } from "bun:test";

import type { FragmentAnalysis, OperationAnalysis, SelectionAnalysis } from "./types";

import { EntitySource } from "../types/resolver";
import { resolveOperationSelections, resolveSelections } from "./resolveSelections";

const field = (name: string, selections?: SelectionAnalysis[]): SelectionAnalysis => ({
  name,
  ...(selections && { selections }),
});
const spread = (name: string, extra: Partial<SelectionAnalysis> = {}): SelectionAnalysis => ({
  name: `...${name}`,
  ...extra,
});
const inline = (selections: SelectionAnalysis[], extra: Partial<SelectionAnalysis> = {}) => ({
  name: "... on T",
  selections,
  ...extra,
});
const fragment = (name: string, fields: SelectionAnalysis[]): FragmentAnalysis => ({
  name,
  typeCondition: "T",
  fields,
});

const SKIP = [{ name: "skip", arguments: { if: true } }];
const keepAll = () => true;
const notSkipped = (selection: SelectionAnalysis) => !selection.directives?.length;
const names = (selections: SelectionAnalysis[]) => selections.map((entry) => entry.name);

describe("resolveSelections", () => {
  it("flattens an inline fragment into the set it sits in", () => {
    const resolved = resolveSelections([field("a"), inline([field("b")])], [], keepAll);

    expect(names(resolved)).toEqual(["a", "b"]);
  });

  it("flattens a named spread into the set it sits in", () => {
    const resolved = resolveSelections([spread("F")], [fragment("F", [field("a")])], keepAll);

    expect(names(resolved)).toEqual(["a"]);
  });

  it("expands one fragment under every field that spreads it", () => {
    const resolved = resolveSelections(
      [field("a", [spread("F")]), field("b", [spread("F")])],
      [fragment("F", [field("x")])],
      keepAll,
    );

    expect(resolved.map((entry) => names(entry.selections!))).toEqual([["x"], ["x"]]);
  });

  it("expands fragments nested in a fragment and in its fields", () => {
    const resolved = resolveSelections(
      [spread("F")],
      [fragment("F", [spread("G"), field("a", [spread("G")])]), fragment("G", [field("x")])],
      keepAll,
    );

    expect(names(resolved)).toEqual(["x", "a"]);
    expect(names(resolved[1]!.selections!)).toEqual(["x"]);
  });

  it("drops a field keep rejects, at any depth", () => {
    const resolved = resolveSelections(
      [field("a", [field("x"), { name: "y", directives: SKIP }]), { name: "b", directives: SKIP }],
      [],
      notSkipped,
    );

    expect(names(resolved)).toEqual(["a"]);
    expect(names(resolved[0]!.selections!)).toEqual(["x"]);
  });

  it("drops a whole fragment when keep rejects its spread or inline entry", () => {
    const resolved = resolveSelections(
      [spread("F", { directives: SKIP }), inline([field("b")], { directives: SKIP }), field("c")],
      [fragment("F", [field("a")])],
      notSkipped,
    );

    expect(names(resolved)).toEqual(["c"]);
  });

  it("drops a field keep rejects inside a fragment", () => {
    const resolved = resolveSelections(
      [spread("F")],
      [fragment("F", [{ name: "a", directives: SKIP }, field("b")])],
      notSkipped,
    );

    expect(names(resolved)).toEqual(["b"]);
  });

  it("still expands a fragment when an earlier spread of it was rejected", () => {
    const resolved = resolveSelections(
      [spread("F", { directives: SKIP }), spread("F")],
      [fragment("F", [field("a")])],
      notSkipped,
    );

    expect(names(resolved)).toEqual(["a"]);
  });

  it("answers an empty selection when every child is rejected", () => {
    const resolved = resolveSelections(
      [field("a", [{ name: "x", directives: SKIP }])],
      [],
      notSkipped,
    );

    expect(resolved).toEqual([{ name: "a", selections: [] }]);
  });

  it("merges a field selected twice across fragments, in first-seen order", () => {
    const resolved = resolveSelections(
      [field("a", [field("x")]), field("b"), spread("F")],
      [fragment("F", [field("a", [field("y"), field("x")]), field("b"), field("c")])],
      keepAll,
    );

    expect(names(resolved)).toEqual(["a", "b", "c"]);
    expect(names(resolved[0]!.selections!)).toEqual(["x", "y"]);
  });

  it("keeps two aliases of one field apart", () => {
    const resolved = resolveSelections(
      [
        inline([
          { name: "a", alias: "one" },
          { name: "a", alias: "two" },
        ]),
      ],
      [],
      keepAll,
    );

    expect(resolved.map((entry) => entry.alias)).toEqual(["one", "two"]);
  });

  it("takes a merged field's arguments from its last occurrence", () => {
    const resolved = resolveSelections(
      [{ name: "a", arguments: { limit: 1 } }, inline([{ name: "a", arguments: { limit: 2 } }])],
      [],
      keepAll,
    );

    expect(resolved).toEqual([{ name: "a", arguments: { limit: 2 } }]);
  });

  it("keeps a transform directive on the field it sits on", () => {
    const upper = [{ name: "uppercase" }];
    const resolved = resolveSelections([inline([{ name: "a", directives: upper }])], [], keepAll);

    expect(resolved).toEqual([{ name: "a", directives: upper }]);
  });

  it("leaves its input untouched", () => {
    const selections = [field("a", [spread("F")])];
    const fragments = [fragment("F", [field("x")])];
    const snapshot = structuredClone({ selections, fragments });

    resolveSelections(selections, fragments, keepAll);

    expect({ selections, fragments }).toEqual(snapshot);
  });

  it("terminates on fragments that spread each other in one set", () => {
    const resolved = resolveSelections(
      [spread("F")],
      [fragment("F", [field("a"), spread("G")]), fragment("G", [field("b"), spread("F")])],
      keepAll,
    );

    expect(names(resolved)).toEqual(["a", "b"]);
  });

  describe("expansion bound", () => {
    // Every level spreads the next under two fields, so the tree doubles with
    // each one: 2^24 leaves from a few dozen selections.
    const fanOut = (levels: number) => [
      ...Array.from({ length: levels }, (_, level) =>
        fragment(`F${level}`, [
          field("a", [spread(`F${level + 1}`)]),
          field("b", [spread(`F${level + 1}`)]),
        ]),
      ),
      fragment(`F${levels}`, [field("x")]),
    ];

    it("rejects fragments that fan out past the bound", () => {
      expect(() => resolveSelections([spread("F0")], fanOut(24), keepAll)).toThrow(
        "Query too complex: fragments expand to more than 50000 selections",
      );
    });

    // Validation rejects these for callers. An operator's unvalidated document
    // has to end in an error too, whichever limit it reaches first.
    it("fails on a cycle through a field rather than recursing forever", () => {
      expect(() =>
        resolveSelections([spread("F")], [fragment("F", [field("a", [spread("F")])])], keepAll),
      ).toThrow();
    });

    it("allows a tree well inside the bound", () => {
      expect(resolveSelections([spread("F0")], fanOut(6), keepAll)).toHaveLength(2);
    });

    it("does not limit a document with no named fragment", () => {
      const wide = Array.from({ length: 60_000 }, (_, index) => field(`f${index}`));

      expect(resolveSelections([inline(wide)], [], keepAll)).toHaveLength(60_000);
    });
  });
});

describe("resolveOperationSelections", () => {
  const entities = {
    getResolverSource: (name: string) => (name === "auth_me" ? EntitySource.AUTH : undefined),
  };
  const operation = (
    fields: SelectionAnalysis[],
    extra: Partial<OperationAnalysis> = {},
  ): OperationAnalysis => ({ name: null, operation: "query", fields, ...extra });

  it("hands back a plain operation as it is", () => {
    const plain = operation([field("a", [field("x", [field("y")])])]);

    expect(resolveOperationSelections(plain, [], {}, entities)).toBe(plain);
  });

  it("gives a root field reached through a fragment its source", () => {
    const resolved = resolveOperationSelections(
      operation([spread("F")]),
      [fragment("F", [field("auth_me", [field("username")])])],
      {},
      entities,
    );

    expect(resolved.fields).toEqual([
      { name: "auth_me", source: EntitySource.AUTH, selections: [{ name: "username" }] },
    ]);
  });

  it("keeps the source a root field already has", () => {
    const tagged = { name: "x", source: EntitySource.TABLE };
    const resolved = resolveOperationSelections(operation([tagged, inline([])]), [], {}, entities);

    expect(resolved.fields).toEqual([tagged]);
  });

  it("drops root meta fields a fragment selects", () => {
    const resolved = resolveOperationSelections(
      operation([inline([{ name: "__typename", typeName: "Query" }, field("auth_me", [])])]),
      [],
      {},
      entities,
    );

    expect(names(resolved.fields)).toEqual(["auth_me"]);
  });

  it("reads a directive's variable from the request", () => {
    const skipped = operation(
      [{ name: "a", directives: [{ name: "skip", arguments: { if: "$s" } }] }, field("b")],
      { variables: [{ name: "s", type: "Boolean", required: true }] },
    );

    expect(names(resolveOperationSelections(skipped, [], { s: true }, entities).fields)).toEqual([
      "b",
    ]);
    expect(names(resolveOperationSelections(skipped, [], { s: false }, entities).fields)).toEqual([
      "a",
      "b",
    ]);
  });

  it("falls back to a variable's declared default", () => {
    const included = operation(
      [{ name: "a", directives: [{ name: "include", arguments: { if: "$i" } }] }],
      { variables: [{ name: "i", type: "Boolean", required: false, defaultValue: false }] },
    );

    expect(resolveOperationSelections(included, [], {}, entities).fields).toEqual([]);
    expect(names(resolveOperationSelections(included, [], { i: true }, entities).fields)).toEqual([
      "a",
    ]);
  });

  it("leaves the cached operation untouched", () => {
    const cached = operation([spread("F")]);
    const snapshot = structuredClone(cached);

    resolveOperationSelections(cached, [fragment("F", [field("auth_me", [])])], {}, entities);

    expect(cached).toEqual(snapshot);
  });

  it("recognises an operation as plain each time", () => {
    const plain = operation([field("a")]);

    expect(resolveOperationSelections(plain, [], {}, entities)).toBe(plain);
    expect(resolveOperationSelections(plain, [], {}, entities)).toBe(plain);
  });
});

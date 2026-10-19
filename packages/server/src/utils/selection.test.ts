import { describe, expect, it } from "bun:test";

import type { SelectionAnalysis } from "../analyzeQuery/types";

import { filterResultBySelection, typenamesOf } from "./selection";

const f = (name: string, selections?: SelectionAnalysis[], alias?: string): SelectionAnalysis => ({
  name,
  selections,
  alias,
});

// A __typename as the analysis records it.
const typename = (typeName: string, alias?: string): SelectionAnalysis => ({
  name: "__typename",
  typeName,
  alias,
});

describe("filterResultBySelection", () => {
  describe("passthrough", () => {
    it("returns data unchanged when fields is undefined", () => {
      expect(filterResultBySelection({ a: 1, b: 2 }, undefined)).toEqual({
        a: 1,
        b: 2,
      });
    });

    it("returns data unchanged when fields is empty", () => {
      expect(filterResultBySelection({ a: 1, b: 2 }, [])).toEqual({
        a: 1,
        b: 2,
      });
    });

    it("returns primitives unchanged", () => {
      expect(filterResultBySelection(42, [f("x")])).toBe(42);
      expect(filterResultBySelection("hello", [f("x")])).toBe("hello");
      expect(filterResultBySelection(null, [f("x")])).toBe(null);
    });
  });

  describe("flat object", () => {
    it("keeps only requested fields", () => {
      const result = filterResultBySelection(
        { id: 1, name: "Alice", email: "a@x", password: "secret" },
        [f("id"), f("name")],
      );
      expect(result).toEqual({ id: 1, name: "Alice" });
    });

    it("omits fields not present in data", () => {
      const result = filterResultBySelection({ id: 1 }, [f("id"), f("missing")]);
      expect(result).toEqual({ id: 1 });
    });

    it("uses alias as output key when present", () => {
      const result = filterResultBySelection({ id: 1, name: "Alice" }, [
        f("name", undefined, "displayName"),
      ]);
      expect(result).toEqual({ displayName: "Alice" });
    });
  });

  describe("nested selections", () => {
    it("recurses into object children using their selection set", () => {
      const data = {
        id: 1,
        author: { id: 7, name: "Bob", password_hash: "secret" },
      };
      const result = filterResultBySelection(data, [f("id"), f("author", [f("id"), f("name")])]);
      expect(result).toEqual({ id: 1, author: { id: 7, name: "Bob" } });
    });
  });

  describe("arrays", () => {
    it("maps a child selection over each array element", () => {
      const data = [
        { id: 1, secret: "a" },
        { id: 2, secret: "b" },
      ];
      const result = filterResultBySelection(data, [f("id")]);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("recurses into nested arrays", () => {
      const data = {
        items: [
          { id: 1, hidden: "x" },
          { id: 2, hidden: "y" },
        ],
      };
      const result = filterResultBySelection(data, [f("items", [f("id")])]);
      expect(result).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    });
  });

  describe("null / undefined values in data", () => {
    it("leaves null values in place when key is requested", () => {
      const result = filterResultBySelection({ a: null, b: 2 }, [f("a")]);
      expect(result).toEqual({ a: null });
    });
  });

  describe("__typename", () => {
    it("answers the type the analysis recorded, under its alias too", () => {
      const result = filterResultBySelection({ id: 1 }, [
        typename("Thing"),
        typename("Thing", "kind"),
        f("id"),
      ]);
      expect(result).toEqual({ __typename: "Thing", kind: "Thing", id: 1 });
    });

    it("names nested objects and each element of a list", () => {
      const data = { child: { a: 1 }, list: [{ a: 2 }, { a: 3 }], none: null };
      const result = filterResultBySelection(data, [
        f("child", [typename("Child"), f("a")]),
        f("list", [typename("Item")]),
        f("none", [typename("Child")]),
      ]);
      expect(result).toEqual({
        child: { __typename: "Child", a: 1 },
        list: [{ __typename: "Item" }, { __typename: "Item" }],
        none: null,
      });
    });

    it("answers the schema's type over a __typename the data carries", () => {
      expect(filterResultBySelection({ __typename: "Other" }, [typename("Thing")])).toEqual({
        __typename: "Thing",
      });
    });
  });
});

describe("typenamesOf", () => {
  it("maps each __typename's response key to its type", () => {
    expect(typenamesOf([typename("Thing"), typename("Thing", "kind"), f("id")])).toEqual({
      __typename: "Thing",
      kind: "Thing",
    });
  });

  it("is empty without a selection", () => {
    expect(typenamesOf(undefined)).toEqual({});
  });
});

import { describe, expect, it } from "bun:test";

import type { SelectionAnalysis } from "../analyzeQuery/types";

import { filterResultBySelection } from "./selection";

const f = (name: string, selections?: SelectionAnalysis[], alias?: string): SelectionAnalysis => ({
  name,
  selections,
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
});

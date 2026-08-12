import { describe, expect, it } from "bun:test";

import { assertSafeIdentifier } from "./identifier";

describe("assertSafeIdentifier", () => {
  describe("accepts safe identifiers", () => {
    const valid = [
      "users",
      "user_profiles",
      "USERS",
      "_leading_underscore",
      "a1",
      "A_1_b_2",
      "snake_case_with_numbers_123",
      "x", // single char letter
      "_", // single char underscore
      "PascalCase",
      "camelCase",
    ];

    for (const id of valid) {
      it(`returns ${JSON.stringify(id)} unchanged`, () => {
        expect(assertSafeIdentifier(id)).toBe(id);
      });
    }
  });

  describe("rejects unsafe identifiers", () => {
    const invalid = [
      "", // empty
      "1leading_digit",
      "with space",
      "with;semicolon",
      "with-hyphen",
      'with"doublequote',
      "with'singlequote",
      "with`backtick",
      "with(paren",
      "with*star",
      "with/slash",
      "schema.table", // dots NOT allowed — caller must split first
      "café", // unicode
      "тест", // cyrillic
      "name\n",
      "name\t",
      "--; DROP TABLE users",
      "users; DROP TABLE x",
      "$dollar",
      "@at",
      "#hash",
      "[bracketed]",
    ];

    for (const id of invalid) {
      it(`throws on ${JSON.stringify(id)}`, () => {
        expect(() => assertSafeIdentifier(id)).toThrow();
      });
    }
  });

  describe("error message", () => {
    it("includes the bad value in the message", () => {
      expect(() => assertSafeIdentifier("bad value")).toThrow("bad value");
    });

    it("uses the default label when none provided", () => {
      expect(() => assertSafeIdentifier("bad value")).toThrow(/Invalid identifier:/);
    });

    it("uses the custom label when provided", () => {
      expect(() => assertSafeIdentifier("bad value", "schema")).toThrow(/Invalid schema:/);
    });

    it("includes the bad value alongside the custom label", () => {
      expect(() => assertSafeIdentifier("oops!", "table")).toThrow("Invalid table: oops!");
    });
  });
});

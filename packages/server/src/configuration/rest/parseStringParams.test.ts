import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { parseStringParams } from "./parseStringParams";

describe("parseStringParams", () => {
  it("returns undefined when no schema is configured", () => {
    expect(parseStringParams(undefined, { active: "true" })).toBeUndefined();
  });

  it("parses directly when the schema declares no boolean key", () => {
    const schema = z.object({ name: z.string(), count: z.coerce.number() });

    expect(parseStringParams(schema, { name: "bob", count: "3" })).toEqual({
      name: "bob",
      count: 3,
    });
  });

  it("converts every truthy spelling", () => {
    const schema = z.object({ active: z.boolean() });

    for (const spelling of ["true", "1", "yes", "on", "y", "enabled"]) {
      expect(parseStringParams(schema, { active: spelling })).toEqual({ active: true });
    }
  });

  it("converts every falsy spelling", () => {
    const schema = z.object({ active: z.boolean() });

    for (const spelling of ["false", "0", "no", "off", "n", "disabled"]) {
      expect(parseStringParams(schema, { active: spelling })).toEqual({ active: false });
    }
  });

  it("ignores the casing of a spelling", () => {
    const schema = z.object({ active: z.boolean() });

    expect(parseStringParams(schema, { active: "TRUE" })).toEqual({ active: true });
    expect(parseStringParams(schema, { active: "Off" })).toEqual({ active: false });
  });

  it("leaves a value that spells neither as the string it was", () => {
    const schema = z.object({ active: z.boolean() });

    expect(() => parseStringParams(schema, { active: "maybe" })).toThrow(z.ZodError);
  });

  it("leaves keys that are not booleans untouched", () => {
    const schema = z.object({ active: z.boolean(), name: z.string() });

    expect(parseStringParams(schema, { active: "true", name: "true" })).toEqual({
      active: true,
      name: "true",
    });
  });

  // Each wrapper keeps the validated type of the schema it wraps, so a boolean
  // behind any of them still has to be converted.
  it.each([
    ["optional", z.boolean().optional()],
    ["nullable", z.boolean().nullable()],
    ["nonoptional", z.boolean().optional().nonoptional()],
    ["default", z.boolean().default(false)],
    ["prefault", z.boolean().prefault(false)],
    ["catch", z.boolean().catch(false)],
    ["readonly", z.boolean().readonly()],
  ])("resolves a boolean wrapped in %s", (_name, field) => {
    const schema = z.object({ active: field });

    expect(parseStringParams(schema, { active: "yes" })).toEqual({ active: true });
  });

  it("keeps an absent optional key absent", () => {
    const schema = z.object({ active: z.boolean().optional(), name: z.string() });

    expect(parseStringParams(schema, { name: "bob" })).toEqual({ name: "bob" });
  });

  // A pipe validates its input side, so `z.stringbool()` is a string on the
  // wire. Converting it first would hand a boolean to a schema expecting a
  // string and fail.
  it("does not convert a stringbool", () => {
    const schema = z.object({ active: z.stringbool() });

    expect(parseStringParams(schema, { active: "true" })).toEqual({ active: true });
  });

  it("converts a boolean alongside a stringbool", () => {
    const schema = z.object({ plain: z.boolean(), piped: z.stringbool() });

    expect(parseStringParams(schema, { plain: "on", piped: "off" })).toEqual({
      plain: true,
      piped: false,
    });
  });

  it("returns the same result when a schema is reused", () => {
    const schema = z.object({ active: z.boolean() });

    expect(parseStringParams(schema, { active: "true" })).toEqual({ active: true });
    expect(parseStringParams(schema, { active: "false" })).toEqual({ active: false });
  });
});

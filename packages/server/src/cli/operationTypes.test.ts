import { describe, expect, it } from "bun:test";
import { format } from "oxfmt";

import { EMPTY_OPERATION_TYPES, renderOperationTypes, typeOfSchema } from "./operationTypes";

describe("typeOfSchema", () => {
  it.each([
    [{ type: "string", nullable: false }, "string"],
    [{ type: "number", nullable: true }, "number"],
    [{ type: "boolean" }, "boolean"],
    [{}, "unknown"],
    [{ type: "integer" }, "unknown"],
  ])("types %j as %s", (schema, expected) => {
    expect(typeOfSchema(schema)).toBe(expected);
  });

  it("keeps an inner list's own nullability", () => {
    expect(
      typeOfSchema({
        type: "array",
        items: { type: "array", items: { type: "number", nullable: true }, nullable: true },
      }),
    ).toBe("((number | null)[] | null)[]");
  });

  it("makes a key outside required optional and nullable, unknown left bare", () => {
    expect(
      typeOfSchema({
        type: "object",
        properties: { id: { type: "number" }, title: { type: "string" }, extra: {} },
        required: ["id"],
      }),
    ).toBe("{ id: number; title?: string | null; extra?: unknown }");
  });

  it("types nested lists, reading nullable on scalar items only", () => {
    expect(
      typeOfSchema({
        type: "array",
        items: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string", nullable: true } } },
          required: ["tags"],
          nullable: true,
        },
      }),
    ).toBe("{ tags: (string | null)[] }[]");
  });
});

describe("renderOperationTypes", () => {
  it("augments the global interface, quoting a key that is not an identifier", () => {
    const text = renderOperationTypes({
      books: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      "get-books": { type: "object", properties: {}, required: [] },
    });

    expect(text).toContain("declare global {");
    expect(text).toContain("interface GraphoriaGeneratedOperationOutputs {");
    expect(text).toContain("books: { n: number };");
    expect(text).toContain('"get-books": Record<string, never>;');
    expect(text).toEndWith("export {};\n");
  });

  it("writes init's file, never an empty interface, with no operation to type", async () => {
    expect(renderOperationTypes({})).toBe(EMPTY_OPERATION_TYPES);
    expect((await format("graphoria-env.d.ts", EMPTY_OPERATION_TYPES)).code).toBe(
      EMPTY_OPERATION_TYPES,
    );
  });
});

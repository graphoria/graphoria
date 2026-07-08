import { describe, expect, it } from "bun:test";

import type { OperationAnalysis, VariableDefinition } from "./types";

import {
  buildFinalVariables,
  extractRuntimePrimitivesToVariables,
  flattenObjectVariables,
  resolveFieldArguments,
  resolveVariableRef,
  resolveVariables,
  validateVariables,
} from "./resolveVariables";

// ─── extractRuntimePrimitivesToVariables ─────────────────────────────────────

describe("extractRuntimePrimitivesToVariables", () => {
  describe("primitive value extraction", () => {
    it("should extract string primitive and create static variable", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { field: { eq: "test-value" } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({ field: { eq: "$static_0" } });
      expect(generatedVariables).toEqual([
        {
          name: "static_0",
          type: "String",
          required: false,
          defaultValue: "test-value",
        },
      ]);
      expect(runtimeVariables).toEqual({ static_0: "test-value" });
    });

    it("should extract integer primitive and create static variable", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { order_id: { eq: 42 } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({ order_id: { eq: "$static_0" } });
      expect(generatedVariables).toEqual([
        {
          name: "static_0",
          type: "Int",
          required: false,
          defaultValue: 42,
        },
      ]);
      expect(runtimeVariables).toEqual({ static_0: 42 });
    });

    it("should extract float primitive and create static variable", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { price: { gte: 99.99 } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({ price: { gte: "$static_0" } });
      expect(generatedVariables).toEqual([
        {
          name: "static_0",
          type: "Float",
          required: false,
          defaultValue: 99.99,
        },
      ]);
      expect(runtimeVariables).toEqual({ static_0: 99.99 });
    });

    it("should extract boolean primitive and create static variable", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { is_active: { eq: true } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({ is_active: { eq: "$static_0" } });
      expect(generatedVariables).toEqual([
        {
          name: "static_0",
          type: "Boolean",
          required: false,
          defaultValue: true,
        },
      ]);
      expect(runtimeVariables).toEqual({ static_0: true });
    });
  });

  describe("multiple values extraction", () => {
    it("should extract multiple primitives in order", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { price: { gte: 100, lte: 500 } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        price: { gte: "$static_0", lte: "$static_1" },
      });
      expect(generatedVariables).toHaveLength(2);
      expect(generatedVariables[0]).toEqual({
        name: "static_0",
        type: "Int",
        required: false,
        defaultValue: 100,
      });
      expect(generatedVariables[1]).toEqual({
        name: "static_1",
        type: "Int",
        required: false,
        defaultValue: 500,
      });
      expect(runtimeVariables).toEqual({ static_0: 100, static_1: 500 });
    });

    it("should handle mixed type primitives", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        {
          name: { eq: "Product" },
          price: { gte: 100 },
          is_available: { eq: true },
        },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        name: { eq: "$static_0" },
        price: { gte: "$static_1" },
        is_available: { eq: "$static_2" },
      });
      expect(generatedVariables).toHaveLength(3);
      expect(runtimeVariables).toEqual({
        static_0: "Product",
        static_1: 100,
        static_2: true,
      });
    });
  });

  describe("nested structures", () => {
    it("should handle _and logical operator with array", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        {
          _and: [{ field1: { eq: 1 } }, { field2: { eq: "value" } }],
        },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        _and: [{ field1: { eq: "$static_0" } }, { field2: { eq: "$static_1" } }],
      });
      expect(generatedVariables).toHaveLength(2);
      expect(runtimeVariables).toEqual({ static_0: 1, static_1: "value" });
    });

    it("should handle _or logical operator with array", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        {
          _or: [{ status: { eq: "active" } }, { status: { eq: "pending" } }],
        },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        _or: [{ status: { eq: "$static_0" } }, { status: { eq: "$static_1" } }],
      });
      expect(generatedVariables).toHaveLength(2);
    });

    it("should handle deeply nested objects", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        {
          _and: [
            { category: { eq: "electronics" } },
            {
              _or: [{ price: { lt: 100 } }, { on_sale: { eq: true } }],
            },
          ],
        },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        _and: [
          { category: { eq: "$static_0" } },
          {
            _or: [{ price: { lt: "$static_1" } }, { on_sale: { eq: "$static_2" } }],
          },
        ],
      });
      expect(generatedVariables).toHaveLength(3);
    });
  });

  describe("preserving special values", () => {
    it("should preserve existing variable references", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { user_id: { eq: "$userId" }, status: { eq: "active" } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        user_id: { eq: "$userId" },
        status: { eq: "$static_0" },
      });
      expect(generatedVariables).toHaveLength(1);
      expect(generatedVariables[0].defaultValue).toBe("active");
    });

    it("should parameterize all plain strings including header-like values", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        {
          organization_id: { eq: "some-org-id" },
          name: { eq: "Test" },
        },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        organization_id: { eq: "$static_0" },
        name: { eq: "$static_1" },
      });
      expect(generatedVariables).toHaveLength(2);
      expect(runtimeVariables).toEqual({
        static_0: "some-org-id",
        static_1: "Test",
      });
    });

    it("should handle null values", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { deleted_at: { is_null: true }, name: null },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        deleted_at: { is_null: "$static_0" },
        name: null,
      });
      expect(generatedVariables).toHaveLength(1);
    });
  });

  describe("startIndex handling", () => {
    it("should use startIndex for variable naming", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { field: { eq: "test" } },
        generatedVariables,
        runtimeVariables,
        5, // Start at index 5
      );

      expect(result).toEqual({ field: { eq: "$static_5" } });
      expect(generatedVariables[0].name).toBe("static_5");
    });

    it("should correctly increment from startIndex with multiple values", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { a: { eq: 1 }, b: { eq: 2 }, c: { eq: 3 } },
        generatedVariables,
        runtimeVariables,
        10,
      );

      expect(result).toEqual({
        a: { eq: "$static_10" },
        b: { eq: "$static_11" },
        c: { eq: "$static_12" },
      });
      expect(generatedVariables.map((v) => v.name)).toEqual([
        "static_10",
        "static_11",
        "static_12",
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty object", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        {},
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({});
      expect(generatedVariables).toHaveLength(0);
    });

    it("should handle empty array", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { _and: [] },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({ _and: [] });
      expect(generatedVariables).toHaveLength(0);
    });

    it("should return undefined as-is", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        undefined,
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toBeUndefined();
      expect(generatedVariables).toHaveLength(0);
    });

    it("should return null as-is", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        null,
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toBeNull();
      expect(generatedVariables).toHaveLength(0);
    });

    it("should handle 'in' operator with array of values", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};

      const result = extractRuntimePrimitivesToVariables(
        { status: { in: ["active", "pending", "review"] } },
        generatedVariables,
        runtimeVariables,
        0,
      );

      expect(result).toEqual({
        status: { in: ["$static_0", "$static_1", "$static_2"] },
      });
      expect(generatedVariables).toHaveLength(3);
      expect(runtimeVariables).toEqual({
        static_0: "active",
        static_1: "pending",
        static_2: "review",
      });
    });
  });

  describe("tracking referenced variables", () => {
    it("should track nested variable references", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};
      const referencedVariables = new Set<string>();

      const result = extractRuntimePrimitivesToVariables(
        { user_id: { eq: "$userId" }, status: { eq: "active" } },
        generatedVariables,
        runtimeVariables,
        0,
        referencedVariables,
      );

      expect(result).toEqual({
        user_id: { eq: "$userId" },
        status: { eq: "$static_0" },
      });
      expect(referencedVariables.has("userId")).toBe(true);
      expect(referencedVariables.size).toBe(1);
    });

    it("should track multiple nested variable references", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};
      const referencedVariables = new Set<string>();

      const result = extractRuntimePrimitivesToVariables(
        {
          _and: [
            { user_id: { eq: "$userId" } },
            { org_id: { eq: "$orgId" } },
            { status: { eq: "active" } },
          ],
        },
        generatedVariables,
        runtimeVariables,
        0,
        referencedVariables,
      );

      expect(result).toEqual({
        _and: [
          { user_id: { eq: "$userId" } },
          { org_id: { eq: "$orgId" } },
          { status: { eq: "$static_0" } },
        ],
      });
      expect(referencedVariables.has("userId")).toBe(true);
      expect(referencedVariables.has("orgId")).toBe(true);
      expect(referencedVariables.size).toBe(2);
    });

    it("should not track plain strings as referenced variables", () => {
      const generatedVariables: VariableDefinition[] = [];
      const runtimeVariables: Record<string, unknown> = {};
      const referencedVariables = new Set<string>();

      extractRuntimePrimitivesToVariables(
        { org_id: { eq: "some-org-id" } },
        generatedVariables,
        runtimeVariables,
        0,
        referencedVariables,
      );

      expect(referencedVariables.size).toBe(0);
      expect(generatedVariables).toHaveLength(1);
      expect(generatedVariables[0].name).toBe("static_0");
      expect(runtimeVariables).toEqual({ static_0: "some-org-id" });
    });
  });
});

// ─── resolveVariableRef ─────────────────────────────────────────────────────

describe("resolveVariableRef", () => {
  it("should resolve a $variable reference", () => {
    expect(resolveVariableRef({ name: "Alice" }, "$name")).toBe("Alice");
  });

  it("should return non-string values unchanged", () => {
    expect(resolveVariableRef({}, 42)).toBe(42);
    expect(resolveVariableRef({}, true)).toBe(true);
    expect(resolveVariableRef({}, null)).toBe(null);
  });

  it("should return plain strings unchanged", () => {
    expect(resolveVariableRef({}, "hello")).toBe("hello");
  });

  it("should throw on undefined variable", () => {
    expect(() => resolveVariableRef({}, "$missing")).toThrow("Variable missing not found");
  });
});

// ─── validateVariables ──────────────────────────────────────────────────────

describe("validateVariables", () => {
  it("should pass with all variables provided", () => {
    expect(() =>
      validateVariables([{ name: "id", type: "Int", required: true }], {
        id: 1,
      }),
    ).not.toThrow();
  });

  it("should pass when variable has defaultValue", () => {
    expect(() =>
      validateVariables([{ name: "id", type: "Int", required: false, defaultValue: 5 }], {}),
    ).not.toThrow();
  });

  it("should throw on missing required variable", () => {
    expect(() => validateVariables([{ name: "id", type: "Int", required: true }], {})).toThrow(
      "Missing value for variable: $id",
    );
  });

  it("should handle undefined variables list", () => {
    expect(() => validateVariables(undefined, {})).not.toThrow();
  });
});

// ─── flattenObjectVariables ─────────────────────────────────────────────────

describe("flattenObjectVariables", () => {
  it("should flatten object-type variables into static refs", () => {
    const vars: VariableDefinition[] = [{ name: "where", type: "WhereInput", required: false }];
    const result = flattenObjectVariables(vars, { where: { id: { eq: 1 } } }, 0);

    expect(result.resolvedMap.size).toBe(1);
    expect(result.resolvedMap.get("where")).toEqual({
      id: { eq: "$static_0" },
    });
    expect(result.newStaticVariables).toHaveLength(1);
    expect(result.resolvedObjectVarNames.has("where")).toBe(true);
  });

  it("should skip primitive-type variables", () => {
    const vars: VariableDefinition[] = [{ name: "id", type: "Int", required: true }];
    const result = flattenObjectVariables(vars, { id: 1 }, 0);

    expect(result.resolvedMap.size).toBe(0);
    expect(result.resolvedObjectVarNames.size).toBe(0);
  });

  it("should skip static_ variables", () => {
    const vars: VariableDefinition[] = [
      { name: "static_0", type: "Int", required: false, defaultValue: 5 },
    ];
    const result = flattenObjectVariables(vars, {}, 0);

    expect(result.resolvedMap.size).toBe(0);
  });

  it("should track nested variable references", () => {
    const vars: VariableDefinition[] = [{ name: "where", type: "WhereInput", required: false }];
    const result = flattenObjectVariables(vars, { where: { user_id: { eq: "$userId" } } }, 0);

    expect(result.nestedReferencedVars.has("userId")).toBe(true);
  });
});

// ─── resolveFieldArguments ──────────────────────────────────────────────────

describe("resolveFieldArguments", () => {
  it("should replace $varName references with resolved objects", () => {
    const fields = [{ name: "users", arguments: { where: "$where" } }];
    const resolvedMap = new Map<string, unknown>([["where", { id: { eq: "$static_0" } }]]);

    const result = resolveFieldArguments(fields, resolvedMap);

    expect(result[0].arguments?.where).toEqual({ id: { eq: "$static_0" } });
    // Original unchanged
    expect(fields[0].arguments?.where).toBe("$where");
  });

  it("should recurse into nested selections", () => {
    const fields = [
      {
        name: "classes",
        arguments: { where: "$where" },
        selections: [{ name: "attendance", arguments: { where: "$subWhere" } }],
      },
    ];
    const resolvedMap = new Map<string, unknown>([
      ["where", { id: { eq: "$static_0" } }],
      ["subWhere", { date: { eq: "$static_1" } }],
    ]);

    const result = resolveFieldArguments(fields, resolvedMap);

    expect(result[0].selections?.[0].arguments?.where).toEqual({
      date: { eq: "$static_1" },
    });
    // Original unchanged
    expect(fields[0].selections?.[0].arguments?.where).toBe("$subWhere");
  });

  it("should replace session variables in ALL arguments, not just where", () => {
    const fields = [
      {
        name: "users",
        arguments: {
          where: { user_id: { eq: "$session.sub" } },
          orderBy: { created_by: { eq: "$session.sub" } },
        },
      },
    ];

    const result = resolveFieldArguments(fields, new Map(), {
      sub: "user-123",
      role: "user",
    });

    expect(result[0].arguments?.where).toEqual({
      user_id: { eq: "user-123" },
    });
    expect(result[0].arguments?.orderBy).toEqual({
      created_by: { eq: "user-123" },
    });
  });

  it("should not mutate original fields", () => {
    const fields = [
      {
        name: "users",
        arguments: {
          where: { user_id: { eq: "$session.sub" } },
        },
      },
    ];
    const originalArgs = { ...fields[0].arguments };

    resolveFieldArguments(fields, new Map(), {
      sub: "user-123",
      role: "user",
    });

    // Original untouched
    expect(fields[0].arguments).toEqual(originalArgs);
  });
});

// ─── buildFinalVariables ────────────────────────────────────────────────────

describe("buildFinalVariables", () => {
  it("should remove consumed object vars and add static vars", () => {
    const originalVars: VariableDefinition[] = [
      { name: "where", type: "WhereInput", required: false },
      { name: "limit", type: "Int", required: false },
    ];
    const flattenResult = {
      resolvedMap: new Map(),
      newStaticVariables: [{ name: "static_0", type: "Int", required: false, defaultValue: 1 }],
      resolvedRuntimeValues: { static_0: 1 },
      resolvedObjectVarNames: new Set(["where"]),
      nestedReferencedVars: new Set<string>(),
    };

    const result = buildFinalVariables(originalVars, flattenResult, {
      limit: 10,
    });

    expect(result.variables).toEqual([
      { name: "limit", type: "Int", required: false },
      { name: "static_0", type: "Int", required: false, defaultValue: 1 },
    ]);
    expect(result.allVariables.limit).toBe(10);
    expect(result.allVariables.static_0).toBe(1);
  });

  it("should preserve nested referenced vars", () => {
    const originalVars: VariableDefinition[] = [
      { name: "where", type: "WhereInput", required: false },
      { name: "userId", type: "Int", required: true },
    ];
    const flattenResult = {
      resolvedMap: new Map(),
      newStaticVariables: [
        {
          name: "static_0",
          type: "String",
          required: false,
          defaultValue: "active",
        },
      ],
      resolvedRuntimeValues: { static_0: "active" },
      resolvedObjectVarNames: new Set(["where"]),
      nestedReferencedVars: new Set(["userId"]),
    };

    const result = buildFinalVariables(originalVars, flattenResult, {
      userId: 42,
    });

    // userId preserved because it's in nestedReferencedVars
    expect(result.variables.some((v) => v.name === "userId")).toBe(true);
    expect(result.variables.some((v) => v.name === "where")).toBe(false);
  });

  it("should merge defaults → runtime → generated values", () => {
    const originalVars: VariableDefinition[] = [
      { name: "limit", type: "Int", required: false, defaultValue: 5 },
    ];
    const flattenResult = {
      resolvedMap: new Map(),
      newStaticVariables: [],
      resolvedRuntimeValues: {},
      resolvedObjectVarNames: new Set<string>(),
      nestedReferencedVars: new Set<string>(),
    };

    const result = buildFinalVariables(originalVars, flattenResult, {
      limit: 20,
    });

    // Runtime overrides default
    expect(result.allVariables.limit).toBe(20);
  });
});

// ─── resolveVariables (orchestrator) ────────────────────────────────────────

describe("resolveVariables", () => {
  it("should return ResolvedOperation without modifying input operation", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [{ name: "where", type: "pg_public_classesWhereInput", required: false }],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where" },
        },
      ],
    };

    // Deep-clone to compare later
    const originalVars = JSON.parse(JSON.stringify(operation.variables));
    const originalFields = JSON.parse(JSON.stringify(operation.fields));

    const resolved = resolveVariables(operation, {
      where: { id: { eq: 1 } },
    });

    // Input NOT mutated
    expect(operation.variables).toEqual(originalVars);
    expect(operation.fields).toEqual(originalFields);

    // Resolved has the expected shape
    expect(resolved.variables).toEqual([
      { name: "static_0", type: "Int", required: false, defaultValue: 1 },
    ]);
    expect(resolved.allVariables.static_0).toBe(1);
    expect(resolved.fields[0].arguments?.where).toEqual({
      id: { eq: "$static_0" },
    });
  });

  it("should not modify operation with only primitive variables", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [{ name: "id", type: "Int", required: true }],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: { id: { eq: "$id" } } },
        },
      ],
    };

    const resolved = resolveVariables(operation, { id: 1 });

    expect(resolved.variables).toEqual([{ name: "id", type: "Int", required: true }]);
    expect(resolved.allVariables).toEqual({ id: 1 });
    expect(resolved.fields[0].arguments?.where).toEqual({
      id: { eq: "$id" },
    });
  });

  it("should resolve object variable and extract primitives", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [{ name: "where", type: "pg_public_classesWhereInput", required: false }],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where" },
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      where: { id: { eq: 1 } },
    });

    // Object variable removed, static variable added
    expect(resolved.variables).toEqual([
      { name: "static_0", type: "Int", required: false, defaultValue: 1 },
    ]);
    expect(resolved.allVariables.static_0).toBe(1);

    // Field argument should be resolved to the transformed object
    expect(resolved.fields[0].arguments?.where).toEqual({
      id: { eq: "$static_0" },
    });
  });

  it("should handle mixed primitive and object variables", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [
        { name: "where", type: "pg_public_classesWhereInput", required: false },
        { name: "limit", type: "Int", required: false },
      ],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where", limit: "$limit" },
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      where: { id: { eq: 1 } },
      limit: 10,
    });

    // limit stays, where is replaced by static_0
    expect(resolved.variables).toEqual([
      { name: "limit", type: "Int", required: false },
      { name: "static_0", type: "Int", required: false, defaultValue: 1 },
    ]);
    expect(resolved.allVariables.static_0).toBe(1);
    expect(resolved.allVariables.limit).toBe(10);
    // where resolved, limit untouched
    expect(resolved.fields[0].arguments?.where).toEqual({
      id: { eq: "$static_0" },
    });
    expect(resolved.fields[0].arguments?.limit).toBe("$limit");
  });

  it("should resolve nested field arguments", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [
        { name: "where", type: "pg_public_classesWhereInput", required: false },
        {
          name: "subWhere",
          type: "pg_public_attendanceWhereInput",
          required: false,
        },
      ],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where" },
          selections: [
            {
              name: "pg_public_attendance",
              arguments: { where: "$subWhere" },
            },
          ],
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      where: { id: { eq: 1 } },
      subWhere: { date: { eq: "2024-01-01" } },
    });

    // Both object variables resolved
    expect(resolved.variables.some((v) => v.name === "where")).toBe(false);
    expect(resolved.variables.some((v) => v.name === "subWhere")).toBe(false);
    expect(resolved.variables.filter((v) => v.name.startsWith("static_"))).toHaveLength(2);

    // Nested argument resolved
    expect(resolved.fields[0].selections?.[0].arguments?.where).toEqual({
      date: { eq: "$static_1" },
    });
  });

  it("should preserve nested $variable references inside object variables", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [
        { name: "where", type: "pg_public_classesWhereInput", required: false },
        { name: "userId", type: "Int", required: true },
      ],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where" },
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      where: { user_id: { eq: "$userId" }, status: { eq: "active" } },
      userId: 42,
    });

    // userId should be kept (it's referenced inside the where object)
    expect(resolved.variables.some((v) => v.name === "userId")).toBe(true);
    // where should be removed
    expect(resolved.variables.some((v) => v.name === "where")).toBe(false);
    // static_0 created for "active"
    expect(resolved.variables.some((v) => v.name === "static_0")).toBe(true);

    expect(resolved.fields[0].arguments?.where).toEqual({
      user_id: { eq: "$userId" },
      status: { eq: "$static_0" },
    });
  });

  it("should keep static variables from query analysis", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [
        { name: "static_0", type: "Int", required: false, defaultValue: 5 },
        { name: "where", type: "pg_public_classesWhereInput", required: false },
      ],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where", limit: "$static_0" },
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      where: { id: { eq: 1 } },
    });

    // Original static_0 kept, new one named static_1
    expect(resolved.variables[0]).toEqual({
      name: "static_0",
      type: "Int",
      required: false,
      defaultValue: 5,
    });
    expect(resolved.variables[1]).toEqual({
      name: "static_1",
      type: "Int",
      required: false,
      defaultValue: 1,
    });
  });

  it("should handle empty variables", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [],
      fields: [{ name: "pg_public_classes" }],
    };

    const resolved = resolveVariables(operation, {});

    expect(resolved.allVariables).toEqual({});
  });

  it("should handle undefined variables", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      fields: [{ name: "pg_public_classes" }],
    };

    const resolved = resolveVariables(operation, {});

    expect(resolved.allVariables).toEqual({});
  });

  it("should throw on missing required variable", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [{ name: "id", type: "Int", required: true }],
      fields: [{ name: "pg_public_classes" }],
    };

    expect(() => resolveVariables(operation, {})).toThrow("Missing value for variable: $id");
  });

  it("should not throw when variable has defaultValue", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [{ name: "static_0", type: "Int", required: false, defaultValue: 5 }],
      fields: [{ name: "pg_public_classes" }],
    };

    const resolved = resolveVariables(operation, {});

    expect(resolved.allVariables.static_0).toBe(5);
  });

  it("should use runtime value over defaultValue", () => {
    const operation: OperationAnalysis = {
      name: "GetUsers",
      operation: "query",
      variables: [
        {
          name: "includeEmail",
          type: "Boolean",
          required: false,
          defaultValue: false,
        },
      ],
      fields: [
        {
          name: "pg_public_users",
          arguments: {},
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      includeEmail: true,
    });

    expect(resolved.allVariables.includeEmail).toBe(true);
  });

  it("should use runtime value over defaultValue with mixed object variables", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [
        {
          name: "includeDetails",
          type: "Boolean",
          required: false,
          defaultValue: false,
        },
        {
          name: "where",
          type: "pg_public_classesWhereInput",
          required: false,
        },
      ],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where" },
        },
      ],
    };

    const resolved = resolveVariables(operation, {
      includeDetails: true,
      where: { id: { eq: 1 } },
    });

    expect(resolved.allVariables.includeDetails).toBe(true);
    expect(resolved.allVariables.static_0).toBe(1);
  });

  it("should fall back to defaultValue when runtime value is not provided", () => {
    const operation: OperationAnalysis = {
      name: "GetUsers",
      operation: "query",
      variables: [
        {
          name: "includeEmail",
          type: "Boolean",
          required: false,
          defaultValue: false,
        },
      ],
      fields: [
        {
          name: "pg_public_users",
          arguments: {},
        },
      ],
    };

    const resolved = resolveVariables(operation, {});

    expect(resolved.allVariables.includeEmail).toBe(false);
  });

  it("should replace session variables in where clauses", () => {
    const operation: OperationAnalysis = {
      name: "GetUsers",
      operation: "query",
      variables: [],
      fields: [
        {
          name: "pg_public_users",
          arguments: {
            where: { user_id: { eq: "$session.sub" } },
          },
        },
      ],
    };

    const resolved = resolveVariables(
      operation,
      {},
      {
        sub: "user-123",
        role: "user",
      },
    );

    expect(resolved.fields[0].arguments?.where).toEqual({
      user_id: { eq: "user-123" },
    });
  });

  it("should replace session variables in non-where arguments", () => {
    const operation: OperationAnalysis = {
      name: "GetUsers",
      operation: "query",
      variables: [],
      fields: [
        {
          name: "pg_public_users",
          arguments: {
            where: { user_id: { eq: "$session.sub" } },
            filter: { org_id: { eq: "$session.organizationId" } },
          },
        },
      ],
    };

    const resolved = resolveVariables(
      operation,
      {},
      {
        sub: "user-123",
        role: "user",
        organizationId: "org-456",
      },
    );

    expect(resolved.fields[0].arguments?.where).toEqual({
      user_id: { eq: "user-123" },
    });
    expect(resolved.fields[0].arguments?.filter).toEqual({
      org_id: { eq: "org-456" },
    });
  });

  it("should never mutate the original operation (immutability check)", () => {
    const operation: OperationAnalysis = {
      name: "GetClass",
      operation: "query",
      variables: [
        { name: "where", type: "pg_public_classesWhereInput", required: false },
        { name: "limit", type: "Int", required: false },
      ],
      fields: [
        {
          name: "pg_public_classes",
          arguments: { where: "$where", limit: "$limit" },
          selections: [
            {
              name: "nested",
              arguments: { where: { user_id: { eq: "$session.sub" } } },
            },
          ],
        },
      ],
    };

    const snapshot = JSON.parse(JSON.stringify(operation));

    resolveVariables(
      operation,
      { where: { id: { eq: 1 } }, limit: 10 },
      { sub: "user-123", role: "user" },
    );

    // Deep equality — nothing mutated
    expect(operation).toEqual(snapshot);
  });
});

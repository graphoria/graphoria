import { describe, expect, it } from "bun:test";
import { parse } from "graphql";

import type { FieldNode, OperationDefinitionNode } from "graphql";

import { analyzeDirectives } from "./directiveUtils";

describe("Directive Analysis", () => {
  it("Should analyze @skip directive with boolean literal", () => {
    const query = parse(`
      {
        dbo_orders {
          order_id
          customer_id @skip(if: true)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "skip",
        arguments: {
          if: true,
        },
      },
    ]);
  });

  it("Should analyze @include directive with boolean literal", () => {
    const query = parse(`
      {
        dbo_orders {
          order_id
          customer_id @include(if: false)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "include",
        arguments: {
          if: false,
        },
      },
    ]);
  });

  it("Should analyze @skip directive with variable", () => {
    const query = parse(`
      query Test($skipField: Boolean!) {
        dbo_orders {
          order_id
          customer_id @skip(if: $skipField)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "skip",
        arguments: {
          if: "$skipField",
        },
      },
    ]);
  });

  it("Should analyze @include directive with variable", () => {
    const query = parse(`
      query Test($includeField: Boolean!) {
        dbo_orders {
          order_id
          customer_id @include(if: $includeField)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "include",
        arguments: {
          if: "$includeField",
        },
      },
    ]);
  });

  it("Should analyze custom directive with string argument", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          name @uppercase
          description @truncate(length: 50)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const descriptionField = field.selectionSet!.selections[2] as FieldNode;

    const directives = analyzeDirectives(descriptionField.directives || []);

    expect(directives).toEqual([
      {
        name: "truncate",
        arguments: {
          length: 50,
        },
      },
    ]);
  });

  it("Should analyze directive with multiple arguments", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          description @substring(start: 0, length: 100)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const descriptionField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(descriptionField.directives || []);

    expect(directives).toEqual([
      {
        name: "substring",
        arguments: {
          start: 0,
          length: 100,
        },
      },
    ]);
  });

  it("Should analyze multiple directives on same field", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          name @uppercase @trim
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const nameField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(nameField.directives || []);

    expect(directives).toEqual([
      {
        name: "uppercase",
      },
      {
        name: "trim",
      },
    ]);
  });

  it("Should analyze directive without arguments", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          name @uppercase
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const nameField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(nameField.directives || []);

    expect(directives).toEqual([
      {
        name: "uppercase",
      },
    ]);
  });

  it("Should handle empty directives array", () => {
    const directives = analyzeDirectives([]);
    expect(directives).toEqual([]);
  });

  it("Should analyze directive with float argument", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          price @multiply(by: 1.5)
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const priceField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(priceField.directives || []);

    expect(directives).toEqual([
      {
        name: "multiply",
        arguments: {
          by: 1.5,
        },
      },
    ]);
  });

  it("Should analyze directive with string argument", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          name @replace(find: "old", replaceWith: "new")
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const nameField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(nameField.directives || []);

    expect(directives).toEqual([
      {
        name: "replace",
        arguments: {
          find: "old",
          replaceWith: "new",
        },
      },
    ]);
  });

  it("Should analyze directive with mixed argument types", () => {
    const query = parse(`
      {
        dbo_products {
          product_id
          description @pad(length: 100, char: " ", side: "right")
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const descriptionField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(descriptionField.directives || []);

    expect(directives).toEqual([
      {
        name: "pad",
        arguments: {
          length: 100,
          char: " ",
          side: "right",
        },
      },
    ]);
  });

  it("Should analyze @when directive with and argument using variables", () => {
    const query = parse(`
      query Test($isAdmin: Boolean!, $showDetails: Boolean!) {
        dbo_orders {
          order_id
          customer_id @when(and: [$isAdmin, $showDetails])
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "when",
        arguments: {
          and: ["$isAdmin", "$showDetails"],
        },
      },
    ]);
  });

  it("Should analyze @when directive with or argument using variables", () => {
    const query = parse(`
      query Test($flagA: Boolean!, $flagB: Boolean!) {
        dbo_orders {
          order_id
          customer_id @when(or: [$flagA, $flagB])
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "when",
        arguments: {
          or: ["$flagA", "$flagB"],
        },
      },
    ]);
  });

  it("Should analyze @when directive with literal booleans", () => {
    const query = parse(`
      {
        dbo_orders {
          order_id
          customer_id @when(and: [true, false])
        }
      }
    `);

    const operation = query.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const customerIdField = field.selectionSet!.selections[1] as FieldNode;

    const directives = analyzeDirectives(customerIdField.directives || []);

    expect(directives).toEqual([
      {
        name: "when",
        arguments: {
          and: [true, false],
        },
      },
    ]);
  });

  describe("SQL injection prevention", () => {
    it("should parameterize string args in spec'd directives (no raw interpolation)", () => {
      const query = parse(`
        {
          dbo_products {
            name @replace(find: "'; DROP TABLE users; --", replaceWith: "safe")
          }
        }
      `);

      const operation = query.definitions[0] as OperationDefinitionNode;
      const field = operation.selectionSet.selections[0] as FieldNode;
      const nameField = field.selectionSet!.selections[0] as FieldNode;

      const generatedVariables: {
        name: string;
        type: string;
        required: boolean;
        defaultValue?: unknown;
      }[] = [];
      const directives = analyzeDirectives(nameField.directives || [], generatedVariables);

      // String args must be parameterized as $static_N, never raw
      expect(directives).toHaveLength(1);
      const args = directives[0].arguments!;
      expect(typeof args.find).toBe("string");
      expect((args.find as string).startsWith("$static_")).toBe(true);
      expect(typeof args.replaceWith).toBe("string");
      expect((args.replaceWith as string).startsWith("$static_")).toBe(true);
      // Verify the SQL injection payload was pushed to generatedVariables
      expect(generatedVariables.some((v) => v.defaultValue === "'; DROP TABLE users; --")).toBe(
        true,
      );
      expect(generatedVariables.some((v) => v.defaultValue === "safe")).toBe(true);
    });

    it("should parameterize numeric args in spec'd directives", () => {
      const query = parse(`
        {
          dbo_products {
            description @truncate(length: 50)
          }
        }
      `);

      const operation = query.definitions[0] as OperationDefinitionNode;
      const field = operation.selectionSet.selections[0] as FieldNode;
      const descField = field.selectionSet!.selections[0] as FieldNode;

      const generatedVariables: {
        name: string;
        type: string;
        required: boolean;
        defaultValue?: unknown;
      }[] = [];
      const directives = analyzeDirectives(descField.directives || [], generatedVariables);

      expect(directives).toHaveLength(1);
      const args = directives[0].arguments!;
      expect(typeof args.length).toBe("string");
      expect((args.length as string).startsWith("$static_")).toBe(true);
    });

    it("should reject unknown arg names on spec'd directives", () => {
      const query = parse(`
        {
          dbo_products {
            name @truncate(badArg: 123)
          }
        }
      `);

      const operation = query.definitions[0] as OperationDefinitionNode;
      const field = operation.selectionSet.selections[0] as FieldNode;
      const nameField = field.selectionSet!.selections[0] as FieldNode;

      expect(() => analyzeDirectives(nameField.directives || [])).toThrow(
        'Unknown argument "badArg" for directive @truncate',
      );
    });

    it("should reject invalid enum values", () => {
      const query = parse(`
        {
          dbo_products {
            name @pad(length: 10, side: "middle")
          }
        }
      `);

      const operation = query.definitions[0] as OperationDefinitionNode;
      const field = operation.selectionSet.selections[0] as FieldNode;
      const nameField = field.selectionSet!.selections[0] as FieldNode;

      expect(() => analyzeDirectives(nameField.directives || [])).toThrow(
        'Invalid value "middle" for @pad(side:). Expected one of: left, right',
      );
    });

    it("should leave @skip/@include/@when untouched (no parameterization, no validation)", () => {
      const query = parse(`
        {
          dbo_products {
            name @skip(if: true) @include(if: false)
          }
        }
      `);

      const operation = query.definitions[0] as OperationDefinitionNode;
      const field = operation.selectionSet.selections[0] as FieldNode;
      const nameField = field.selectionSet!.selections[0] as FieldNode;

      const directives = analyzeDirectives(nameField.directives || []);

      expect(directives).toEqual([
        { name: "skip", arguments: { if: true } },
        { name: "include", arguments: { if: false } },
      ]);
    });
  });
});

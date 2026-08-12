import { describe, expect, test } from "bun:test";

import type { DatabaseType } from "../types/configuration";

import { filterBasedOnDirective } from "./common";
import { DIRECTIVE_HANDLERS, applyDirectives } from "./directives";

describe("Directive Handlers", () => {
  describe("uppercase directive", () => {
    test("should convert to UPPER function", () => {
      const result = DIRECTIVE_HANDLERS.uppercase("name", { name: "uppercase" }, "pg");
      expect(result).toBe("UPPER(name)");
    });

    test("should work with table alias", () => {
      const result = DIRECTIVE_HANDLERS.uppercase("t1.name", { name: "uppercase" }, "pg");
      expect(result).toBe("UPPER(t1.name)");
    });
  });

  describe("lowercase directive", () => {
    test("should convert to LOWER function", () => {
      const result = DIRECTIVE_HANDLERS.lowercase("name", { name: "lowercase" }, "pg");
      expect(result).toBe("LOWER(name)");
    });

    test("should work with complex expressions", () => {
      const result = DIRECTIVE_HANDLERS.lowercase(
        "CONCAT(first_name, last_name)",
        { name: "lowercase" },
        "pg",
      );
      expect(result).toBe("LOWER(CONCAT(first_name, last_name))");
    });
  });

  describe("truncate directive", () => {
    test("should truncate to specified length", () => {
      const result = DIRECTIVE_HANDLERS.truncate(
        "description",
        { name: "truncate", arguments: { length: 50 } },
        "pg",
      );
      expect(result).toBe("LEFT(description, 50)");
    });

    test("should work with different lengths", () => {
      const result = DIRECTIVE_HANDLERS.truncate(
        "bio",
        { name: "truncate", arguments: { length: 100 } },
        "pg",
      );
      expect(result).toBe("LEFT(bio, 100)");
    });
  });

  describe("default directive", () => {
    test("should use COALESCE with custom value", () => {
      const result = DIRECTIVE_HANDLERS.default(
        "middle_name",
        { name: "default", arguments: { value: "Unknown" } },
        "pg",
      );
      expect(result).toBe("COALESCE(middle_name, 'Unknown')");
    });

    test("should use N/A when no value provided", () => {
      const result = DIRECTIVE_HANDLERS.default("optional_field", { name: "default" }, "pg");
      expect(result).toBe("COALESCE(optional_field, 'N/A')");
    });

    test("should handle empty string as value", () => {
      const result = DIRECTIVE_HANDLERS.default(
        "field",
        { name: "default", arguments: { value: "" } },
        "pg",
      );
      expect(result).toBe("COALESCE(field, '')");
    });
  });

  describe("trim directive", () => {
    test("should use TRIM function", () => {
      const result = DIRECTIVE_HANDLERS.trim("name", { name: "trim" }, "pg");
      expect(result).toBe("TRIM(name)");
    });
  });

  describe("ltrim directive", () => {
    test("should use LTRIM function", () => {
      const result = DIRECTIVE_HANDLERS.ltrim("name", { name: "ltrim" }, "pg");
      expect(result).toBe("LTRIM(name)");
    });
  });

  describe("rtrim directive", () => {
    test("should use RTRIM function", () => {
      const result = DIRECTIVE_HANDLERS.rtrim("name", { name: "rtrim" }, "pg");
      expect(result).toBe("RTRIM(name)");
    });
  });

  describe("substring directive", () => {
    test("should extract substring with start and length", () => {
      const result = DIRECTIVE_HANDLERS.substring(
        "description",
        { name: "substring", arguments: { start: 1, length: 10 } },
        "pg",
      );
      expect(result).toBe("SUBSTRING(description, 1, 10)");
    });

    test("should work with different positions", () => {
      const result = DIRECTIVE_HANDLERS.substring(
        "text",
        { name: "substring", arguments: { start: 5, length: 20 } },
        "pg",
      );
      expect(result).toBe("SUBSTRING(text, 5, 20)");
    });
  });

  describe("replace directive", () => {
    test("should replace text", () => {
      const result = DIRECTIVE_HANDLERS.replace(
        "email",
        {
          name: "replace",
          arguments: { find: "@", replaceWith: " [at] " },
        },
        "pg",
      );
      expect(result).toBe("REPLACE(email, '@', ' [at] ')");
    });

    test("should handle special characters", () => {
      const result = DIRECTIVE_HANDLERS.replace(
        "path",
        { name: "replace", arguments: { find: "/", replaceWith: "\\" } },
        "pg",
      );
      expect(result).toBe("REPLACE(path, '/', '\\')");
    });
  });

  describe("concat directive", () => {
    test("should concatenate after by default", () => {
      const result = DIRECTIVE_HANDLERS.concat(
        "name",
        { name: "concat", arguments: { with: " Jr." } },
        "pg",
      );
      expect(result).toBe("CONCAT(name, ' Jr.')");
    });

    test("should concatenate before when specified", () => {
      const result = DIRECTIVE_HANDLERS.concat(
        "name",
        { name: "concat", arguments: { with: "Dr. ", position: "before" } },
        "pg",
      );
      expect(result).toBe("CONCAT('Dr. ', name)");
    });

    test("should concatenate after when explicitly specified", () => {
      const result = DIRECTIVE_HANDLERS.concat(
        "code",
        { name: "concat", arguments: { with: "-SUFFIX", position: "after" } },
        "pg",
      );
      expect(result).toBe("CONCAT(code, '-SUFFIX')");
    });
  });

  describe("pad directive", () => {
    describe("PostgreSQL", () => {
      test("should left pad by default", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "code",
          { name: "pad", arguments: { length: 10 } },
          "pg",
        );
        expect(result).toBe("LPAD(code::TEXT, 10, ' ')");
      });

      test("should left pad with custom character", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "id",
          { name: "pad", arguments: { length: 8, char: "0" } },
          "pg",
        );
        expect(result).toBe("LPAD(id::TEXT, 8, '0')");
      });

      test("should right pad when specified", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "code",
          { name: "pad", arguments: { length: 10, side: "right" } },
          "pg",
        );
        expect(result).toBe("RPAD(code::TEXT, 10, ' ')");
      });

      test("should right pad with custom character", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "text",
          { name: "pad", arguments: { length: 15, char: "*", side: "right" } },
          "pg",
        );
        expect(result).toBe("RPAD(text::TEXT, 15, '*')");
      });
    });

    describe("MSSQL", () => {
      test("should left pad by default", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "code",
          { name: "pad", arguments: { length: 10 } },
          "mssql",
        );
        expect(result).toBe("RIGHT(REPLICATE(' ', 10) + CAST(code AS VARCHAR(MAX)), 10)");
      });

      test("should left pad with custom character", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "id",
          { name: "pad", arguments: { length: 8, char: "0" } },
          "mssql",
        );
        expect(result).toBe("RIGHT(REPLICATE('0', 8) + CAST(id AS VARCHAR(MAX)), 8)");
      });

      test("should right pad when specified", () => {
        const result = DIRECTIVE_HANDLERS.pad(
          "code",
          { name: "pad", arguments: { length: 10, side: "right" } },
          "mssql",
        );
        expect(result).toBe("LEFT(CAST(code AS VARCHAR(MAX)) + REPLICATE(' ', 10), 10)");
      });
    });
  });

  describe("dateFormat directive", () => {
    test("should format date in PostgreSQL", () => {
      const result = DIRECTIVE_HANDLERS.dateFormat(
        "created_at",
        { name: "dateFormat", arguments: { format: "YYYY-MM-DD" } },
        "pg",
      );
      expect(result).toBe("TO_CHAR(created_at, 'YYYY-MM-DD')");
    });

    test("should format date in MSSQL", () => {
      const result = DIRECTIVE_HANDLERS.dateFormat(
        "created_at",
        { name: "dateFormat", arguments: { format: "yyyy-MM-dd" } },
        "mssql",
      );
      expect(result).toBe("FORMAT(created_at, 'yyyy-MM-dd')");
    });

    test("should handle complex format patterns", () => {
      const result = DIRECTIVE_HANDLERS.dateFormat(
        "timestamp",
        {
          name: "dateFormat",
          arguments: { format: "YYYY-MM-DD HH24:MI:SS" },
        },
        "pg",
      );
      expect(result).toBe("TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS')");
    });
  });

  describe("round directive", () => {
    test("should round to 0 decimals by default", () => {
      const result = DIRECTIVE_HANDLERS.round("price", { name: "round" }, "pg");
      expect(result).toBe("ROUND(price, 0)");
    });

    test("should round to specified decimals", () => {
      const result = DIRECTIVE_HANDLERS.round(
        "price",
        { name: "round", arguments: { decimals: 2 } },
        "pg",
      );
      expect(result).toBe("ROUND(price, 2)");
    });

    test("should handle different decimal places", () => {
      const result = DIRECTIVE_HANDLERS.round(
        "value",
        { name: "round", arguments: { decimals: 4 } },
        "pg",
      );
      expect(result).toBe("ROUND(value, 4)");
    });
  });

  describe("ceil directive", () => {
    test("should use CEIL in PostgreSQL", () => {
      const result = DIRECTIVE_HANDLERS.ceil("price", { name: "ceil" }, "pg");
      expect(result).toBe("CEIL(price)");
    });

    test("should use CEILING in MSSQL", () => {
      const result = DIRECTIVE_HANDLERS.ceil("price", { name: "ceil" }, "mssql");
      expect(result).toBe("CEILING(price)");
    });

    test("should use CEILING in MySQL", () => {
      const result = DIRECTIVE_HANDLERS.ceil("price", { name: "ceil" }, "mysql");
      expect(result).toBe("CEILING(price)");
    });
  });

  describe("floor directive", () => {
    test("should use FLOOR function", () => {
      const result = DIRECTIVE_HANDLERS.floor("price", { name: "floor" }, "pg");
      expect(result).toBe("FLOOR(price)");
    });

    test("should work across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = DIRECTIVE_HANDLERS.floor("value", { name: "floor" }, db);
        expect(result).toBe("FLOOR(value)");
      });
    });
  });

  describe("abs directive", () => {
    test("should use ABS function", () => {
      const result = DIRECTIVE_HANDLERS.abs("balance", { name: "abs" }, "pg");
      expect(result).toBe("ABS(balance)");
    });

    test("should work with negative expressions", () => {
      const result = DIRECTIVE_HANDLERS.abs("(total - cost)", { name: "abs" }, "pg");
      expect(result).toBe("ABS((total - cost))");
    });
  });

  describe("multiply directive", () => {
    test("should multiply by specified value", () => {
      const result = DIRECTIVE_HANDLERS.multiply(
        "price",
        { name: "multiply", arguments: { by: 1.1 } },
        "pg",
      );
      expect(result).toBe("(price * 1.1)");
    });

    test("should multiply by integer", () => {
      const result = DIRECTIVE_HANDLERS.multiply(
        "quantity",
        { name: "multiply", arguments: { by: 10 } },
        "pg",
      );
      expect(result).toBe("(quantity * 10)");
    });
  });

  describe("divide directive", () => {
    test("should divide by specified value", () => {
      const result = DIRECTIVE_HANDLERS.divide(
        "total",
        { name: "divide", arguments: { by: 2 } },
        "pg",
      );
      expect(result).toBe("(total / 2)");
    });

    test("should divide by decimal", () => {
      const result = DIRECTIVE_HANDLERS.divide(
        "amount",
        { name: "divide", arguments: { by: 1.5 } },
        "pg",
      );
      expect(result).toBe("(amount / 1.5)");
    });
  });
});

describe("applyDirectives", () => {
  test("should return original query when no directives", () => {
    const result = applyDirectives("name", undefined, "pg");
    expect(result).toBe("name");
  });

  test("should return original query when empty directives array", () => {
    const result = applyDirectives("name", [], "pg");
    expect(result).toBe("name");
  });

  test("should apply single directive", () => {
    const result = applyDirectives("name", [{ name: "uppercase" }], "pg");
    expect(result).toBe("UPPER(name)");
  });

  test("should apply multiple directives in order", () => {
    const result = applyDirectives("name", [{ name: "trim" }, { name: "uppercase" }], "pg");
    expect(result).toBe("UPPER(TRIM(name))");
  });

  test("should chain complex directives", () => {
    const result = applyDirectives(
      "description",
      [{ name: "trim" }, { name: "truncate", arguments: { length: 50 } }, { name: "uppercase" }],
      "pg",
    );
    expect(result).toBe("UPPER(LEFT(TRIM(description), 50))");
  });

  test("should skip unknown directives", () => {
    const result = applyDirectives(
      "name",
      [{ name: "uppercase" }, { name: "unknownDirective" }, { name: "lowercase" }],
      "pg",
    );
    expect(result).toBe("LOWER(UPPER(name))");
  });

  test("should handle directives with arguments", () => {
    const result = applyDirectives(
      "email",
      [{ name: "lowercase" }, { name: "replace", arguments: { find: "@", replaceWith: " [at] " } }],
      "pg",
    );
    expect(result).toBe("REPLACE(LOWER(email), '@', ' [at] ')");
  });

  test("should apply directives with database-specific logic", () => {
    const resultPg = applyDirectives(
      "date_field",
      [{ name: "dateFormat", arguments: { format: "YYYY-MM-DD" } }],
      "pg",
    );
    expect(resultPg).toBe("TO_CHAR(date_field, 'YYYY-MM-DD')");

    const resultMssql = applyDirectives(
      "date_field",
      [{ name: "dateFormat", arguments: { format: "yyyy-MM-dd" } }],
      "mssql",
    );
    expect(resultMssql).toBe("FORMAT(date_field, 'yyyy-MM-dd')");
  });

  test("should handle complex directive chains with mixed types", () => {
    const result = applyDirectives(
      "price",
      [
        { name: "multiply", arguments: { by: 1.1 } },
        { name: "round", arguments: { decimals: 2 } },
        { name: "default", arguments: { value: "0.00" } },
      ],
      "pg",
    );
    expect(result).toBe("COALESCE(ROUND((price * 1.1), 2), '0.00')");
  });

  test("should apply string directives in sequence", () => {
    const result = applyDirectives(
      "name",
      [
        { name: "trim" },
        { name: "lowercase" },
        { name: "concat", arguments: { with: "@example.com" } },
      ],
      "pg",
    );
    expect(result).toBe("CONCAT(LOWER(TRIM(name)), '@example.com')");
  });

  test("should handle pad directive with different databases", () => {
    const resultPg = applyDirectives(
      "id",
      [{ name: "pad", arguments: { length: 5, char: "0" } }],
      "pg",
    );
    expect(resultPg).toBe("LPAD(id::TEXT, 5, '0')");

    const resultMssql = applyDirectives(
      "id",
      [{ name: "pad", arguments: { length: 5, char: "0" } }],
      "mssql",
    );
    expect(resultMssql).toBe("RIGHT(REPLICATE('0', 5) + CAST(id AS VARCHAR(MAX)), 5)");
  });

  test("should handle mathematical operations chain", () => {
    const result = applyDirectives(
      "value",
      [{ name: "abs" }, { name: "multiply", arguments: { by: 2 } }, { name: "floor" }],
      "pg",
    );
    expect(result).toBe("FLOOR((ABS(value) * 2))");
  });

  test("should combine text formatting directives", () => {
    const result = applyDirectives("status", [{ name: "uppercase" }, { name: "trim" }], "pg");
    expect(result).toBe("TRIM(UPPER(status))");
  });

  describe("positional placeholder resolution", () => {
    test("should resolve $static_N refs to PG positional placeholders", () => {
      const result = applyDirectives(
        "col",
        [{ name: "truncate", arguments: { length: "$static_0" } }],
        "pg",
        [{ name: "static_0", type: "Int", required: false, defaultValue: 50 }],
      );
      expect(result).toBe("LEFT(col, $1)");
    });

    test("should resolve $static_N refs to MSSQL positional placeholders", () => {
      const result = applyDirectives(
        "col",
        [{ name: "truncate", arguments: { length: "$static_1" } }],
        "mssql",
        [
          { name: "static_0", type: "String", required: false, defaultValue: "x" },
          { name: "static_1", type: "Int", required: false, defaultValue: 100 },
        ],
      );
      expect(result).toBe("LEFT(col, @2)");
    });

    test("should resolve string $static_N refs in replace directive", () => {
      const result = applyDirectives(
        "email",
        [{ name: "replace", arguments: { find: "$static_0", replaceWith: "$static_1" } }],
        "pg",
        [
          { name: "static_0", type: "String", required: false, defaultValue: "@" },
          { name: "static_1", type: "String", required: false, defaultValue: " [at] " },
        ],
      );
      expect(result).toBe("REPLACE(email, $1, $2)");
    });

    test("should leave enum values as literals (not parameterized)", () => {
      const result = applyDirectives(
        "name",
        [{ name: "concat", arguments: { with: "$static_0", position: "before" } }],
        "pg",
        [{ name: "static_0", type: "String", required: false, defaultValue: "Dr. " }],
      );
      // "before" is an enum value — stays literal; "$static_0" becomes $1
      expect(result).toBe("CONCAT($1, name)");
    });

    test("should leave non-$ values untouched", () => {
      const result = applyDirectives(
        "price",
        [{ name: "round", arguments: { decimals: 2 } }],
        "pg",
        [],
      );
      // Raw number, not a $ref — passed through as-is
      expect(result).toBe("ROUND(price, 2)");
    });
  });
});

describe("Edge Cases and Real-World Scenarios", () => {
  describe("boundary values", () => {
    test("should handle truncate with zero length", () => {
      const result = DIRECTIVE_HANDLERS.truncate(
        "text",
        { name: "truncate", arguments: { length: 0 } },
        "pg",
      );
      expect(result).toBe("LEFT(text, 0)");
    });

    test("should handle round with negative decimals", () => {
      const result = DIRECTIVE_HANDLERS.round(
        "price",
        { name: "round", arguments: { decimals: -1 } },
        "pg",
      );
      expect(result).toBe("ROUND(price, -1)");
    });

    test("should handle pad with length 1", () => {
      const result = DIRECTIVE_HANDLERS.pad(
        "code",
        { name: "pad", arguments: { length: 1 } },
        "pg",
      );
      expect(result).toBe("LPAD(code::TEXT, 1, ' ')");
    });

    test("should handle substring at position 0", () => {
      const result = DIRECTIVE_HANDLERS.substring(
        "text",
        { name: "substring", arguments: { start: 0, length: 5 } },
        "pg",
      );
      expect(result).toBe("SUBSTRING(text, 0, 5)");
    });
  });

  describe("special characters in selectors", () => {
    test("should handle quoted column names", () => {
      const result = DIRECTIVE_HANDLERS.uppercase('"user_name"', { name: "uppercase" }, "pg");
      expect(result).toBe('UPPER("user_name")');
    });

    test("should handle schema-qualified names", () => {
      const result = DIRECTIVE_HANDLERS.lowercase(
        "public.users.email",
        { name: "lowercase" },
        "pg",
      );
      expect(result).toBe("LOWER(public.users.email)");
    });

    test("should handle nested function calls", () => {
      const result = DIRECTIVE_HANDLERS.trim("COALESCE(name, 'Unknown')", { name: "trim" }, "pg");
      expect(result).toBe("TRIM(COALESCE(name, 'Unknown'))");
    });
  });

  describe("common real-world directive combinations", () => {
    test("should clean and format email addresses", () => {
      const result = applyDirectives(
        "email",
        [
          { name: "trim" },
          { name: "lowercase" },
          { name: "default", arguments: { value: "no-email@example.com" } },
        ],
        "pg",
      );
      expect(result).toBe("COALESCE(LOWER(TRIM(email)), 'no-email@example.com')");
    });

    test("should format phone numbers", () => {
      const result = applyDirectives(
        "phone",
        [
          { name: "replace", arguments: { find: "-", replaceWith: "" } },
          { name: "replace", arguments: { find: " ", replaceWith: "" } },
          { name: "replace", arguments: { find: "(", replaceWith: "" } },
          { name: "replace", arguments: { find: ")", replaceWith: "" } },
        ],
        "pg",
      );
      expect(result).toBe(
        "REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '(', ''), ')', '')",
      );
    });

    test("should format currency with rounding and default", () => {
      const result = applyDirectives(
        "price",
        [
          { name: "multiply", arguments: { by: 1.1 } },
          { name: "round", arguments: { decimals: 2 } },
          { name: "default", arguments: { value: "0.00" } },
        ],
        "pg",
      );
      expect(result).toBe("COALESCE(ROUND((price * 1.1), 2), '0.00')");
    });

    test("should create display names", () => {
      const result = applyDirectives(
        "first_name",
        [
          { name: "trim" },
          { name: "concat", arguments: { with: " ", position: "after" } },
          { name: "default", arguments: { value: "Guest User" } },
        ],
        "pg",
      );
      expect(result).toBe("COALESCE(CONCAT(TRIM(first_name), ' '), 'Guest User')");
    });

    test("should format product codes with padding", () => {
      const result = applyDirectives(
        "product_id",
        [
          { name: "pad", arguments: { length: 10, char: "0" } },
          { name: "uppercase" },
          { name: "concat", arguments: { with: "PROD-", position: "before" } },
        ],
        "pg",
      );
      expect(result).toBe("CONCAT('PROD-', UPPER(LPAD(product_id::TEXT, 10, '0')))");
    });

    test("should handle percentage calculations", () => {
      const result = applyDirectives(
        "completion_rate",
        [
          { name: "multiply", arguments: { by: 100 } },
          { name: "round", arguments: { decimals: 1 } },
        ],
        "pg",
      );
      expect(result).toBe("ROUND((completion_rate * 100), 1)");
    });
  });

  describe("database-specific edge cases", () => {
    test("should handle MySQL date formatting", () => {
      const result = applyDirectives(
        "created_at",
        [{ name: "dateFormat", arguments: { format: "%Y-%m-%d" } }],
        "mysql",
      );
      expect(result).toBe("FORMAT(created_at, '%Y-%m-%d')");
    });

    test("should handle PostgreSQL text casting with multiple directives", () => {
      const result = applyDirectives(
        "id",
        [
          { name: "pad", arguments: { length: 8, char: "0" } },
          { name: "concat", arguments: { with: "-SUFFIX" } },
        ],
        "pg",
      );
      expect(result).toBe("CONCAT(LPAD(id::TEXT, 8, '0'), '-SUFFIX')");
    });
  });

  describe("cross-database consistency tests", () => {
    test("uppercase should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives("name", [{ name: "uppercase" }], db);
        expect(result).toBe("UPPER(name)");
      });
    });

    test("lowercase should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives("name", [{ name: "lowercase" }], db);
        expect(result).toBe("LOWER(name)");
      });
    });

    test("trim should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives("name", [{ name: "trim" }], db);
        expect(result).toBe("TRIM(name)");
      });
    });

    test("truncate should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives(
          "text",
          [{ name: "truncate", arguments: { length: 50 } }],
          db,
        );
        expect(result).toBe("LEFT(text, 50)");
      });
    });

    test("replace should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives(
          "email",
          [{ name: "replace", arguments: { find: "@", replaceWith: "_AT_" } }],
          db,
        );
        expect(result).toBe("REPLACE(email, '@', '_AT_')");
      });
    });

    test("round should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives(
          "price",
          [{ name: "round", arguments: { decimals: 2 } }],
          db,
        );
        expect(result).toBe("ROUND(price, 2)");
      });
    });

    test("multiply should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives("value", [{ name: "multiply", arguments: { by: 1.5 } }], db);
        expect(result).toBe("(value * 1.5)");
      });
    });

    test("divide should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives("value", [{ name: "divide", arguments: { by: 2 } }], db);
        expect(result).toBe("(value / 2)");
      });
    });

    test("concat should work identically across all databases", () => {
      const databases: DatabaseType[] = ["pg", "mysql", "mssql"];
      databases.forEach((db) => {
        const result = applyDirectives(
          "first_name",
          [{ name: "concat", arguments: { with: " Smith" } }],
          db,
        );
        expect(result).toBe("CONCAT(first_name, ' Smith')");
      });
    });
  });

  describe("database-specific directive behavior", () => {
    describe("pad directive across databases", () => {
      test("should handle left padding in PostgreSQL", () => {
        const result = applyDirectives(
          "id",
          [{ name: "pad", arguments: { length: 5, char: "0" } }],
          "pg",
        );
        expect(result).toBe("LPAD(id::TEXT, 5, '0')");
      });

      test("should handle left padding in MySQL", () => {
        const result = applyDirectives(
          "id",
          [{ name: "pad", arguments: { length: 5, char: "0" } }],
          "mysql",
        );
        expect(result).toBe("RIGHT(REPLICATE('0', 5) + CAST(id AS VARCHAR(MAX)), 5)");
      });

      test("should handle left padding in MSSQL", () => {
        const result = applyDirectives(
          "id",
          [{ name: "pad", arguments: { length: 5, char: "0" } }],
          "mssql",
        );
        expect(result).toBe("RIGHT(REPLICATE('0', 5) + CAST(id AS VARCHAR(MAX)), 5)");
      });

      test("should handle right padding in PostgreSQL", () => {
        const result = applyDirectives(
          "code",
          [{ name: "pad", arguments: { length: 8, side: "right", char: "X" } }],
          "pg",
        );
        expect(result).toBe("RPAD(code::TEXT, 8, 'X')");
      });

      test("should handle right padding in MySQL", () => {
        const result = applyDirectives(
          "code",
          [{ name: "pad", arguments: { length: 8, side: "right", char: "X" } }],
          "mysql",
        );
        expect(result).toBe("LEFT(CAST(code AS VARCHAR(MAX)) + REPLICATE('X', 8), 8)");
      });

      test("should handle right padding in MSSQL", () => {
        const result = applyDirectives(
          "code",
          [{ name: "pad", arguments: { length: 8, side: "right", char: "X" } }],
          "mssql",
        );
        expect(result).toBe("LEFT(CAST(code AS VARCHAR(MAX)) + REPLICATE('X', 8), 8)");
      });
    });

    describe("dateFormat directive across databases", () => {
      test("should use TO_CHAR in PostgreSQL", () => {
        const result = applyDirectives(
          "created_at",
          [{ name: "dateFormat", arguments: { format: "YYYY-MM-DD" } }],
          "pg",
        );
        expect(result).toBe("TO_CHAR(created_at, 'YYYY-MM-DD')");
      });

      test("should use FORMAT in MySQL", () => {
        const result = applyDirectives(
          "created_at",
          [{ name: "dateFormat", arguments: { format: "%Y-%m-%d" } }],
          "mysql",
        );
        expect(result).toBe("FORMAT(created_at, '%Y-%m-%d')");
      });

      test("should use FORMAT in MSSQL", () => {
        const result = applyDirectives(
          "created_at",
          [{ name: "dateFormat", arguments: { format: "yyyy-MM-dd" } }],
          "mssql",
        );
        expect(result).toBe("FORMAT(created_at, 'yyyy-MM-dd')");
      });

      test("should handle complex date formats in PostgreSQL", () => {
        const result = applyDirectives(
          "timestamp",
          [
            {
              name: "dateFormat",
              arguments: { format: "DD/MM/YYYY HH24:MI:SS" },
            },
          ],
          "pg",
        );
        expect(result).toBe("TO_CHAR(timestamp, 'DD/MM/YYYY HH24:MI:SS')");
      });

      test("should handle complex date formats in MSSQL", () => {
        const result = applyDirectives(
          "timestamp",
          [
            {
              name: "dateFormat",
              arguments: { format: "dd/MM/yyyy HH:mm:ss" },
            },
          ],
          "mssql",
        );
        expect(result).toBe("FORMAT(timestamp, 'dd/MM/yyyy HH:mm:ss')");
      });
    });

    describe("ceil directive across databases", () => {
      test("should use CEIL in PostgreSQL", () => {
        const result = applyDirectives("amount", [{ name: "ceil" }], "pg");
        expect(result).toBe("CEIL(amount)");
      });

      test("should use CEILING in MySQL", () => {
        const result = applyDirectives("amount", [{ name: "ceil" }], "mysql");
        expect(result).toBe("CEILING(amount)");
      });

      test("should use CEILING in MSSQL", () => {
        const result = applyDirectives("amount", [{ name: "ceil" }], "mssql");
        expect(result).toBe("CEILING(amount)");
      });
    });
  });

  describe("complex chains across databases", () => {
    test("should handle mixed directives in PostgreSQL", () => {
      const result = applyDirectives(
        "product_code",
        [
          { name: "trim" },
          { name: "uppercase" },
          { name: "pad", arguments: { length: 10, char: "0" } },
          { name: "concat", arguments: { with: "PROD-", position: "before" } },
        ],
        "pg",
      );
      expect(result).toBe("CONCAT('PROD-', LPAD(UPPER(TRIM(product_code))::TEXT, 10, '0'))");
    });

    test("should handle mixed directives in MySQL", () => {
      const result = applyDirectives(
        "product_code",
        [
          { name: "trim" },
          { name: "uppercase" },
          { name: "pad", arguments: { length: 10, char: "0" } },
          { name: "concat", arguments: { with: "PROD-", position: "before" } },
        ],
        "mysql",
      );
      expect(result).toBe(
        "CONCAT('PROD-', RIGHT(REPLICATE('0', 10) + CAST(UPPER(TRIM(product_code)) AS VARCHAR(MAX)), 10))",
      );
    });

    test("should handle mixed directives in MSSQL", () => {
      const result = applyDirectives(
        "product_code",
        [
          { name: "trim" },
          { name: "uppercase" },
          { name: "pad", arguments: { length: 10, char: "0" } },
          { name: "concat", arguments: { with: "PROD-", position: "before" } },
        ],
        "mssql",
      );
      expect(result).toBe(
        "CONCAT('PROD-', RIGHT(REPLICATE('0', 10) + CAST(UPPER(TRIM(product_code)) AS VARCHAR(MAX)), 10))",
      );
    });

    test("should handle date formatting with conditionals in PostgreSQL", () => {
      const result = applyDirectives(
        "event_date",
        [
          { name: "dateFormat", arguments: { format: "YYYY-MM-DD" } },
          { name: "default", arguments: { value: "No Date" } },
        ],
        "pg",
      );
      expect(result).toBe("COALESCE(TO_CHAR(event_date, 'YYYY-MM-DD'), 'No Date')");
    });

    test("should handle date formatting with conditionals in MSSQL", () => {
      const result = applyDirectives(
        "event_date",
        [
          { name: "dateFormat", arguments: { format: "yyyy-MM-dd" } },
          { name: "default", arguments: { value: "No Date" } },
        ],
        "mssql",
      );
      expect(result).toBe("COALESCE(FORMAT(event_date, 'yyyy-MM-dd'), 'No Date')");
    });

    test("should handle numeric operations with ceil in PostgreSQL", () => {
      const result = applyDirectives(
        "score",
        [
          { name: "multiply", arguments: { by: 1.2 } },
          { name: "ceil" },
          { name: "pad", arguments: { length: 5, char: "0" } },
        ],
        "pg",
      );
      expect(result).toBe("LPAD(CEIL((score * 1.2))::TEXT, 5, '0')");
    });

    test("should handle numeric operations with ceil in MSSQL", () => {
      const result = applyDirectives(
        "score",
        [
          { name: "multiply", arguments: { by: 1.2 } },
          { name: "ceil" },
          { name: "pad", arguments: { length: 5, char: "0" } },
        ],
        "mssql",
      );
      expect(result).toBe(
        "RIGHT(REPLICATE('0', 5) + CAST(CEILING((score * 1.2)) AS VARCHAR(MAX)), 5)",
      );
    });
  });

  describe("string escaping and special values", () => {
    test("should handle single quotes in replace", () => {
      const result = DIRECTIVE_HANDLERS.replace(
        "text",
        { name: "replace", arguments: { find: "'", replaceWith: "''" } },
        "pg",
      );
      expect(result).toBe("REPLACE(text, ''', '''')");
    });

    test("should handle backslashes in concat", () => {
      const result = DIRECTIVE_HANDLERS.concat(
        "path",
        { name: "concat", arguments: { with: "\\folder" } },
        "pg",
      );
      expect(result).toBe("CONCAT(path, '\\folder')");
    });

    test("should handle empty string in default", () => {
      const result = DIRECTIVE_HANDLERS.default(
        "optional",
        { name: "default", arguments: { value: "" } },
        "pg",
      );
      expect(result).toBe("COALESCE(optional, '')");
    });

    test("should handle numeric zero in default", () => {
      const result = DIRECTIVE_HANDLERS.default(
        "count",
        { name: "default", arguments: { value: 0 } },
        "pg",
      );
      expect(result).toBe("COALESCE(count, '0')");
    });
  });

  describe("mathematical operation chains", () => {
    test("should handle complex tax calculation", () => {
      const result = applyDirectives(
        "subtotal",
        [
          { name: "multiply", arguments: { by: 1.08 } }, // 8% tax
          { name: "floor" },
          { name: "divide", arguments: { by: 100 } },
          { name: "round", arguments: { decimals: 2 } },
        ],
        "pg",
      );
      expect(result).toBe("ROUND((FLOOR((subtotal * 1.08)) / 100), 2)");
    });

    test("should handle discount and conversion", () => {
      const result = applyDirectives(
        "original_price",
        [
          { name: "multiply", arguments: { by: 0.85 } }, // 15% discount
          { name: "abs" },
          { name: "ceil" },
        ],
        "pg",
      );
      expect(result).toBe("CEIL(ABS((original_price * 0.85)))");
    });
  });

  describe("text transformation chains", () => {
    test("should normalize and truncate descriptions", () => {
      const result = applyDirectives(
        "description",
        [
          { name: "trim" },
          { name: "replace", arguments: { find: "  ", replaceWith: " " } }, // double spaces
          { name: "truncate", arguments: { length: 100 } },
          { name: "concat", arguments: { with: "..." } },
        ],
        "pg",
      );
      expect(result).toBe("CONCAT(LEFT(REPLACE(TRIM(description), '  ', ' '), 100), '...')");
    });

    test("should create slugs from titles", () => {
      const result = applyDirectives(
        "title",
        [
          { name: "lowercase" },
          { name: "trim" },
          { name: "replace", arguments: { find: " ", replaceWith: "-" } },
        ],
        "pg",
      );
      expect(result).toBe("REPLACE(TRIM(LOWER(title)), ' ', '-')");
    });

    test("should format names with proper casing", () => {
      const result = applyDirectives(
        "last_name",
        [
          { name: "trim" },
          { name: "uppercase" },
          { name: "concat", arguments: { with: ", ", position: "after" } },
        ],
        "pg",
      );
      expect(result).toBe("CONCAT(UPPER(TRIM(last_name)), ', ')");
    });
  });

  describe("conditional and default value patterns", () => {
    test("should format dates with default", () => {
      const result = applyDirectives(
        "last_login",
        [
          { name: "dateFormat", arguments: { format: "YYYY-MM-DD" } },
          { name: "default", arguments: { value: "Never" } },
        ],
        "pg",
      );
      expect(result).toBe("COALESCE(TO_CHAR(last_login, 'YYYY-MM-DD'), 'Never')");
    });
  });

  describe("very long directive chains", () => {
    test("should handle 10+ directives in sequence", () => {
      const result = applyDirectives(
        "raw_value",
        [
          { name: "trim" },
          { name: "lowercase" },
          { name: "replace", arguments: { find: "a", replaceWith: "x" } },
          { name: "replace", arguments: { find: "e", replaceWith: "y" } },
          { name: "truncate", arguments: { length: 20 } },
          { name: "ltrim" },
          { name: "rtrim" },
          { name: "uppercase" },
          { name: "concat", arguments: { with: "_SUFFIX" } },
          { name: "default", arguments: { value: "EMPTY" } },
        ],
        "pg",
      );
      expect(result).toBe(
        "COALESCE(CONCAT(UPPER(RTRIM(LTRIM(LEFT(REPLACE(REPLACE(LOWER(TRIM(raw_value)), 'a', 'x'), 'e', 'y'), 20)))), '_SUFFIX'), 'EMPTY')",
      );
    });
  });

  describe("mixed type operations", () => {
    test("should convert number to formatted string", () => {
      const result = applyDirectives(
        "amount",
        [
          { name: "round", arguments: { decimals: 2 } },
          { name: "pad", arguments: { length: 10, char: "0", side: "left" } },
          { name: "concat", arguments: { with: "$", position: "before" } },
        ],
        "pg",
      );
      expect(result).toBe("CONCAT('$', LPAD(ROUND(amount, 2)::TEXT, 10, '0'))");
    });

    test("should handle numeric operations then string formatting", () => {
      const result = applyDirectives(
        "score",
        [
          { name: "multiply", arguments: { by: 100 } },
          { name: "floor" },
          { name: "pad", arguments: { length: 3, char: "0", side: "left" } },
        ],
        "pg",
      );
      expect(result).toBe("LPAD(FLOOR((score * 100))::TEXT, 3, '0')");
    });
  });
});

describe("filterBasedOnDirective - @when", () => {
  const varDefs = [
    { name: "a", type: "Boolean", required: true },
    { name: "b", type: "Boolean", required: true },
    { name: "c", type: "Boolean", required: false, defaultValue: true },
    { name: "d", type: "Boolean", required: false, defaultValue: false },
  ];

  test("@when(and:) - all variables true → include", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: ["$a", "$b"] } }],
      },
      varDefs,
      { a: true, b: true },
    );
    expect(result).toBe(true);
  });

  test("@when(and:) - one variable false → exclude", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: ["$a", "$b"] } }],
      },
      varDefs,
      { a: true, b: false },
    );
    expect(result).toBe(false);
  });

  test("@when(and:) - all variables false → exclude", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: ["$a", "$b"] } }],
      },
      varDefs,
      { a: false, b: false },
    );
    expect(result).toBe(false);
  });

  test("@when(or:) - one variable true → include", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { or: ["$a", "$b"] } }],
      },
      varDefs,
      { a: false, b: true },
    );
    expect(result).toBe(true);
  });

  test("@when(or:) - all variables false → exclude", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { or: ["$a", "$b"] } }],
      },
      varDefs,
      { a: false, b: false },
    );
    expect(result).toBe(false);
  });

  test("@when(or:) - all variables true → include", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { or: ["$a", "$b"] } }],
      },
      varDefs,
      { a: true, b: true },
    );
    expect(result).toBe(true);
  });

  test("@when(and:) - falls back to variable default value (true)", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: ["$a", "$c"] } }],
      },
      varDefs,
      { a: true },
    );
    expect(result).toBe(true);
  });

  test("@when(and:) - falls back to variable default value (false)", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: ["$a", "$d"] } }],
      },
      varDefs,
      { a: true },
    );
    expect(result).toBe(false);
  });

  test("@when(and:) - literal booleans", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: [true, true] } }],
      },
      [],
      {},
    );
    expect(result).toBe(true);
  });

  test("@when(and:) - literal booleans with one false", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: [true, false] } }],
      },
      [],
      {},
    );
    expect(result).toBe(false);
  });

  test("@when(or:) - literal booleans with one true", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { or: [false, true] } }],
      },
      [],
      {},
    );
    expect(result).toBe(true);
  });

  test("@when(and:) - mixed literals and variables", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: [true, "$a"] } }],
      },
      varDefs,
      { a: true },
    );
    expect(result).toBe(true);
  });

  test("@when - throws error when both and/or provided", () => {
    expect(() =>
      filterBasedOnDirective(
        {
          name: "field",
          directives: [
            {
              name: "when",
              arguments: { and: ["$a"], or: ["$b"] },
            },
          ],
        },
        varDefs,
        { a: true, b: true },
      ),
    ).toThrow('@when directive: "and" and "or" are mutually exclusive');
  });

  test("@when - throws error when variable not found", () => {
    expect(() =>
      filterBasedOnDirective(
        {
          name: "field",
          directives: [{ name: "when", arguments: { and: ["$unknown"] } }],
        },
        varDefs,
        {},
      ),
    ).toThrow("Variable unknown not found");
  });

  test("@when(and:) - unresolved variable defaults to false", () => {
    const result = filterBasedOnDirective(
      {
        name: "field",
        directives: [{ name: "when", arguments: { and: ["$a", "$b"] } }],
      },
      varDefs,
      { a: true },
    );
    expect(result).toBe(false);
  });
});

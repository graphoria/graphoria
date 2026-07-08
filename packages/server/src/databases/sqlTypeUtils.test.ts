import { describe, expect, it } from "bun:test";

import { categorizeSqlType, isNumericType, SqlTypeCategory } from "./sqlTypeUtils";

describe("categorizeSqlType", () => {
  describe("INTEGER", () => {
    const ints = [
      "int",
      "integer",
      "smallint",
      "bigint",
      "tinyint",
      "mediumint",
      "numeric",
      "number",
      "INT", // case-insensitive
      "BigInt",
    ];
    for (const t of ints) {
      it(`${t} → INTEGER`, () => {
        expect(categorizeSqlType(t)).toBe(SqlTypeCategory.INTEGER);
      });
    }
  });

  describe("FLOAT", () => {
    const floats = [
      "float",
      "real",
      "double",
      "double precision",
      "decimal",
      "money",
      "smallmoney",
      "DECIMAL",
    ];
    for (const t of floats) {
      it(`${t} → FLOAT`, () => {
        expect(categorizeSqlType(t)).toBe(SqlTypeCategory.FLOAT);
      });
    }
  });

  describe("BOOLEAN", () => {
    for (const t of ["bit", "bool", "boolean", "BOOL"]) {
      it(`${t} → BOOLEAN`, () => {
        expect(categorizeSqlType(t)).toBe(SqlTypeCategory.BOOLEAN);
      });
    }
  });

  describe("DATE_TIME", () => {
    const dates = [
      "date",
      "time",
      "datetime",
      "datetime2",
      "smalldatetime",
      "timestamp",
      "timestamptz",
      "timestamp with time zone",
      "timestamp without time zone",
      "time with time zone",
      "time without time zone",
      "timetz",
      "year",
      "interval",
    ];
    for (const t of dates) {
      it(`${t} → DATE_TIME`, () => {
        expect(categorizeSqlType(t)).toBe(SqlTypeCategory.DATE_TIME);
      });
    }
  });

  describe("STRING (fallback)", () => {
    const strs = [
      "varchar",
      "nvarchar",
      "char",
      "text",
      "ntext",
      "uuid",
      "json",
      "jsonb",
      "bytea",
      "geometry",
      "anything-unrecognized",
    ];
    for (const t of strs) {
      it(`${t} → STRING`, () => {
        expect(categorizeSqlType(t)).toBe(SqlTypeCategory.STRING);
      });
    }
  });
});

describe("isNumericType", () => {
  it("returns true for integer types", () => {
    expect(isNumericType("int")).toBe(true);
    expect(isNumericType("bigint")).toBe(true);
  });

  it("returns true for floating-point types", () => {
    expect(isNumericType("decimal")).toBe(true);
    expect(isNumericType("double precision")).toBe(true);
  });

  it("returns false for boolean", () => {
    expect(isNumericType("bool")).toBe(false);
  });

  it("returns false for date types", () => {
    expect(isNumericType("timestamp")).toBe(false);
  });

  it("returns false for string/fallback types", () => {
    expect(isNumericType("varchar")).toBe(false);
    expect(isNumericType("uuid")).toBe(false);
  });
});

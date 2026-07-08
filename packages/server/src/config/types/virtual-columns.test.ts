import { describe, expect, it } from "bun:test";

import {
  createOneToBooleanMSSQL,
  createYAndNToBooleanMSSQL,
  virtualColumnExpression,
  virtualColumnFunction,
} from "./virtual-columns";

describe("virtual column helpers", () => {
  it("virtualColumnExpression builds an expression-backed column", () => {
    expect(virtualColumnExpression("full_name", "varchar", true, "a || b")).toEqual({
      virtual: true,
      isNullable: true,
      dataType: "varchar",
      name: "full_name",
      expression: "a || b",
    });
  });

  it("virtualColumnFunction builds a function-backed column", () => {
    expect(virtualColumnFunction("age", "int", false, "DATEDIFF", ["YEAR", "dob"])).toEqual({
      virtual: true,
      isNullable: false,
      dataType: "int",
      name: "age",
      function: "DATEDIFF",
      params: ["YEAR", "dob"],
    });
  });

  it("createOneToBooleanMSSQL / createYAndNToBooleanMSSQL name and type the column", () => {
    const one = createOneToBooleanMSSQL("is_active");
    expect(one.name).toBe("is_active_boolean");
    expect(one.dataType).toBe("bit");
    expect(one.expression).toContain("CAST(1 AS BIT)");

    const yn = createYAndNToBooleanMSSQL("has_access");
    expect(yn.name).toBe("has_access_boolean");
    expect(yn.expression).toContain("'Y'");
  });
});

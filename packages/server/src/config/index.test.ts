import { describe, expect, it } from "bun:test";

import type { ConfigurationFn, ConfigurationHelpers } from ".";

import {
  createOneToBooleanMSSQL,
  createYAndNToBooleanMSSQL,
  operation,
  OperationZod,
  virtualColumnExpression,
  virtualColumnFunction,
  z,
} from ".";

// The same helper set loadConfiguration hands a configuration function.
const helpers: ConfigurationHelpers = {
  z,
  operation,
  createOneToBooleanMSSQL,
  createYAndNToBooleanMSSQL,
  virtualColumnExpression,
  virtualColumnFunction,
};

describe("ConfigurationFn helpers", () => {
  // Type-checked: the helpers' `operation` must accept every field OperationZod
  // parses. It once declared its own copy of the fields and dropped `timeout`.
  it("accept an operation timeout", () => {
    const configure = (({ operation }) => ({
      name: "test",
      version: "1.0.0",
      operations: {
        slow: operation({ handler: async () => "ok", timeout: 60_000 }),
      },
    })) satisfies ConfigurationFn;

    const slow = configure(helpers).operations.slow;

    expect(OperationZod.parse(slow).timeout).toBe(60_000);
  });
});

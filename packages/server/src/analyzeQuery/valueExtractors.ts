import type { ValueNode } from "graphql";
import type { VariableDefinition } from "./types";

// Helper function to extract argument values from AST nodes
// When a static value is found, it creates a virtual variable and returns a variable reference
export const extractArgumentValue = (
  valueNode: ValueNode,
  generatedVariables?: VariableDefinition[],
  // oxlint-disable-next-line typescript/no-explicit-any
): any => {
  switch (valueNode.kind) {
    case "IntValue": {
      const value = parseInt(valueNode.value, 10);
      if (generatedVariables) {
        const varName = `static_${generatedVariables.length}`;

        generatedVariables.push({
          name: varName,
          type: "Int",
          required: false,
          defaultValue: value,
        });

        return `$${varName}`;
      }
      return value;
    }
    case "FloatValue": {
      const value = parseFloat(valueNode.value);
      if (generatedVariables) {
        const varName = `static_${generatedVariables.length}`;

        generatedVariables.push({
          name: varName,
          type: "Float",
          required: false,
          defaultValue: value,
        });

        return `$${varName}`;
      }
      return value;
    }
    case "StringValue": {
      const value = valueNode.value;
      if (generatedVariables) {
        const varName = `static_${generatedVariables.length}`;

        generatedVariables.push({
          name: varName,
          type: "String",
          required: false,
          defaultValue: value,
        });

        return `$${varName}`;
      }
      return value;
    }
    case "BooleanValue": {
      const value = valueNode.value;
      if (generatedVariables) {
        const varName = `static_${generatedVariables.length}`;

        generatedVariables.push({
          name: varName,
          type: "Boolean",
          required: false,
          defaultValue: value,
        });

        return `$${varName}`;
      }
      return value;
    }
    case "EnumValue": {
      return valueNode.value;
    }
    case "ListValue":
      return valueNode.values.map((v) => extractArgumentValue(v, generatedVariables));
    case "ObjectValue":
      return valueNode.fields.reduce(
        (obj, field) => {
          obj[field.name.value] = extractArgumentValue(field.value, generatedVariables);
          return obj;
        },
        {} as { [key: string]: unknown },
      );
    case "NullValue":
      return null;
    case "Variable":
      return `$${valueNode.name.value}`;
    default:
      return null;
  }
};

import type { DirectiveNode } from "graphql";
import type { DirectiveAnalysis, VariableDefinition } from "./types";

import { extractArgumentValue } from "./valueExtractors";

// Directive argument specification — gates which args are parameterized vs enum-validated
interface DirectiveArgSpec {
  type: "Int" | "Float" | "String" | "Boolean";
  kind: "param" | "enum";
  values?: string[];
}

const DIRECTIVE_ARG_SPEC: Record<string, Record<string, DirectiveArgSpec>> = {
  truncate: { length: { type: "Int", kind: "param" } },
  default: { value: { type: "String", kind: "param" } },
  substring: {
    start: { type: "Int", kind: "param" },
    length: { type: "Int", kind: "param" },
  },
  replace: {
    find: { type: "String", kind: "param" },
    replaceWith: { type: "String", kind: "param" },
  },
  concat: {
    with: { type: "String", kind: "param" },
    position: { type: "String", kind: "enum", values: ["before", "after"] },
  },
  pad: {
    length: { type: "Int", kind: "param" },
    char: { type: "String", kind: "param" },
    side: { type: "String", kind: "enum", values: ["left", "right"] },
  },
  dateFormat: { format: { type: "String", kind: "param" } },
  round: { decimals: { type: "Int", kind: "param" } },
  multiply: { by: { type: "Float", kind: "param" } },
  divide: { by: { type: "Float", kind: "param" } },
};

// Control-flow directives — exempt from spec validation, keep raw extraction
const CONTROL_FLOW_DIRECTIVES = new Set(["skip", "include", "when"]);

export const analyzeDirectives = (
  directives: readonly DirectiveNode[],
  generatedVariables?: VariableDefinition[],
): DirectiveAnalysis[] =>
  directives.map((directive) => {
    const name = directive.name.value;

    // Control-flow directives: extract raw (no parameterization, no validation)
    if (CONTROL_FLOW_DIRECTIVES.has(name)) {
      return {
        name,
        ...(directive.arguments &&
          directive.arguments.length > 0 && {
            arguments: Object.fromEntries(
              directive.arguments.map((arg) => [arg.name.value, extractArgumentValue(arg.value)]),
            ),
          }),
      };
    }

    // Spec'd transform directives: validate arg types and parameterize param-kind args
    const spec = DIRECTIVE_ARG_SPEC[name];
    if (spec && directive.arguments) {
      const args: Record<string, unknown> = {};
      for (const arg of directive.arguments) {
        const argName = arg.name.value;
        const argSpec = spec[argName];
        if (!argSpec) {
          throw new Error(`Unknown argument "${argName}" for directive @${name}`);
        }
        if (argSpec.kind === "enum") {
          const value = extractArgumentValue(arg.value);
          if (argSpec.values && !argSpec.values.includes(value as string)) {
            throw new Error(
              `Invalid value "${value}" for @${name}(${argName}:). Expected one of: ${argSpec.values.join(", ")}`,
            );
          }
          args[argName] = value;
        } else {
          // param kind: parameterize through generatedVariables
          args[argName] = extractArgumentValue(arg.value, generatedVariables);
        }
      }
      return { name, arguments: args };
    }

    // No-arg transform directives (uppercase, trim, ceil, floor, abs, lowercase, ltrim, rtrim)
    // or unknown directives: extract raw with no validation
    if (directive.arguments && directive.arguments.length > 0) {
      return {
        name,
        arguments: Object.fromEntries(
          directive.arguments.map((arg) => [arg.name.value, extractArgumentValue(arg.value)]),
        ),
      };
    }
    return { name };
  });

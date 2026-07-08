import type { VariableDefinitionNode } from "graphql";
import type { VariableDefinition } from "../types";

import { processType } from "../typeUtils";
import { extractArgumentValue } from "../valueExtractors";

export const analyzeVariables = (
  variableDefinitions: readonly VariableDefinitionNode[] = [],
): VariableDefinition[] =>
  variableDefinitions.map((varDef) => ({
    name: varDef.variable.name.value,
    required: varDef.type.kind === "NonNullType",
    type: processType(varDef.type),
    ...(varDef.defaultValue && {
      defaultValue: extractArgumentValue(varDef.defaultValue),
    }),
  }));

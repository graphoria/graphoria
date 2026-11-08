import type { FragmentDefinitionNode, GraphQLObjectType } from "graphql";
import type { EntitiesWithSchema, FragmentAnalysis, VariableDefinition } from "../types";

import { analyzeSelections } from "./selectionAnalyzer";

export const analyzeFragment = (
  fragmentDef: FragmentDefinitionNode,
  entities: EntitiesWithSchema,
  generatedVariables: VariableDefinition[],
): FragmentAnalysis => {
  const typeCondition = entities.schema.getType(fragmentDef.typeCondition.name.value) as
    | GraphQLObjectType
    | undefined;

  return {
    name: fragmentDef.name.value,
    typeCondition: fragmentDef.typeCondition.name.value,
    // A REST operation is analyzed under every role, and a role whose schema
    // lacks this type never runs it: its route answers 401.
    fields: typeCondition
      ? analyzeSelections(
          fragmentDef.selectionSet.selections,
          typeCondition,
          entities,
          [],
          generatedVariables,
        )
      : [],
  };
};

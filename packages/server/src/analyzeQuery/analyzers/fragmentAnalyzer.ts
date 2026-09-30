import type { FragmentDefinitionNode, GraphQLObjectType } from "graphql";
import type { EntitiesWithSchema, FragmentAnalysis, VariableDefinition } from "../types";

import { analyzeSelections } from "./selectionAnalyzer";

export const analyzeFragment = (
  fragmentDef: FragmentDefinitionNode,
  entities: EntitiesWithSchema,
  generatedVariables: VariableDefinition[],
): FragmentAnalysis => {
  const typeCondition = entities.schema.getType(
    fragmentDef.typeCondition.name.value,
  ) as GraphQLObjectType;

  return {
    name: fragmentDef.name.value,
    typeCondition: fragmentDef.typeCondition.name.value,
    fields: analyzeSelections(
      fragmentDef.selectionSet.selections,
      typeCondition,
      entities,
      [],
      generatedVariables,
    ),
  };
};

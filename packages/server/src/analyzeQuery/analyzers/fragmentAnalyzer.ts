import type { FragmentDefinitionNode, GraphQLObjectType, GraphQLSchema } from "graphql";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { FragmentAnalysis, VariableDefinition } from "../types";

import { analyzeSelections } from "./selectionAnalyzer";

export const analyzeFragment = (
  fragmentDef: FragmentDefinitionNode,
  entities: MergedEntities,
  gqlSchema: GraphQLSchema,
  generatedVariables: VariableDefinition[],
): FragmentAnalysis => {
  const typeCondition = gqlSchema.getType(
    fragmentDef.typeCondition.name.value,
  ) as GraphQLObjectType;

  return {
    name: fragmentDef.name.value,
    typeCondition: fragmentDef.typeCondition.name.value,
    fields: analyzeSelections(
      fragmentDef.selectionSet.selections,
      typeCondition,
      entities,
      gqlSchema,
      [],
      generatedVariables,
    ),
  };
};

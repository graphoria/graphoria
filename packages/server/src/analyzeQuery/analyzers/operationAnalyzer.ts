import { GraphQLObjectType, GraphQLSchema } from "graphql";

import type { OperationDefinitionNode } from "graphql";
import type { Maybe } from "graphql/jsutils/Maybe";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { OperationAnalysis, VariableDefinition } from "../types";

import { analyzeSelections } from "./selectionAnalyzer";
import { analyzeVariables } from "./variableAnalyzer";

export const analyzeOperation = (
  operationDef: OperationDefinitionNode,
  entities: MergedEntities,
  gqlSchema: GraphQLSchema,
  generatedVariables: VariableDefinition[],
): OperationAnalysis | null => {
  let rootType: Maybe<GraphQLObjectType> | undefined;

  if (operationDef.operation === "query") {
    rootType = gqlSchema.getQueryType();
  } else if (operationDef.operation === "mutation") {
    rootType = gqlSchema.getMutationType();
  } else if (operationDef.operation === "subscription") {
    rootType = gqlSchema.getSubscriptionType();
  }

  if (!rootType) return null;

  const { name, operation, variableDefinitions, selectionSet } = operationDef;

  const declaredVariables = analyzeVariables(variableDefinitions);

  const fields = analyzeSelections(
    selectionSet.selections,
    rootType,
    entities,
    gqlSchema,
    declaredVariables,
    generatedVariables,
  );

  const allVariables = [...declaredVariables, ...generatedVariables];

  return {
    name: name ? name.value : null,
    operation,
    variables: allVariables,
    fields,
  };
};

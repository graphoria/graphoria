import { GraphQLObjectType } from "graphql";

import type { OperationDefinitionNode } from "graphql";
import type { Maybe } from "graphql/jsutils/Maybe";
import type { EntitiesWithSchema, OperationAnalysis, VariableDefinition } from "../types";

import { analyzeSelections } from "./selectionAnalyzer";
import { analyzeVariables } from "./variableAnalyzer";

export const analyzeOperation = (
  operationDef: OperationDefinitionNode,
  entities: EntitiesWithSchema,
  generatedVariables: VariableDefinition[],
): OperationAnalysis | null => {
  let rootType: Maybe<GraphQLObjectType> | undefined;

  if (operationDef.operation === "query") {
    rootType = entities.schema.getQueryType();
  } else if (operationDef.operation === "mutation") {
    rootType = entities.schema.getMutationType();
  } else if (operationDef.operation === "subscription") {
    rootType = entities.schema.getSubscriptionType();
  }

  if (!rootType) return null;

  const { name, operation, variableDefinitions, selectionSet } = operationDef;

  const declaredVariables = analyzeVariables(variableDefinitions);

  const fields = analyzeSelections(
    selectionSet.selections,
    rootType,
    entities,
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

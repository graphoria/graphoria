import { parse } from "graphql";

import type { DocumentNode } from "graphql";
import type { MergedEntities } from "../configuration/getSchemas/mergeEntities";
import type {
  AnalysisResult,
  EntitiesWithSchema,
  SelectionAnalysis,
  VariableDefinition,
} from "./types";

import { analyzeFragment } from "./analyzers/fragmentAnalyzer";
import { analyzeOperation } from "./analyzers/operationAnalyzer";

/**
 * Tag each top-level field with its source from the resolver registry
 */
const tagFieldsWithSource = (
  fields: SelectionAnalysis[],
  entities: MergedEntities,
): SelectionAnalysis[] => {
  return fields.map((field) => ({
    ...field,
    source: entities.getResolverSource(field.name),
  }));
};

// Function to analyze a GraphQL query
export function analyzeQuery(query: string, entities: EntitiesWithSchema): AnalysisResult {
  let ast: DocumentNode | null;

  const generatedVariables: VariableDefinition[] = [];

  const result: AnalysisResult & { errors?: { message: string }[] } = {
    operations: [],
    fragments: [],
  };

  try {
    ast = parse(query);
  } catch (error) {
    result.errors = [
      {
        message: `Error parsing query: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
    return result;
  }

  ast.definitions.forEach((def) => {
    if (def.kind === "OperationDefinition") {
      const operationAnalysis = analyzeOperation(def, entities, generatedVariables);

      if (operationAnalysis) {
        // Tag top-level fields with their source
        operationAnalysis.fields = tagFieldsWithSource(operationAnalysis.fields, entities);
        result.operations.push(operationAnalysis);
      }
    } else if (def.kind === "FragmentDefinition") {
      const fragmentAnalysis = analyzeFragment(def, entities, generatedVariables);

      result.fragments.push(fragmentAnalysis);
    }
  });

  return result;
}

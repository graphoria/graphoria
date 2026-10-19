import { Kind } from "graphql";

import type { DocumentNode, FieldNode, OperationDefinitionNode, SelectionNode } from "graphql";
import type { SelectionAnalysis } from "./types";

/**
 * The meta fields. graphql-js answers them at the root; below it, `__typename`
 * is answered by whatever builds the object.
 */
export const META_FIELDS = new Set(["__schema", "__type", "__typename"]);

const isMetaField = (selection: SelectionNode): selection is FieldNode =>
  selection.kind === Kind.FIELD && META_FIELDS.has(selection.name.value);

/** A `__typename` below the root, which the analysis gives its type's name. */
export type TypenameSelection = SelectionAnalysis & { typeName: string };

export const isTypename = (selection: SelectionAnalysis): selection is TypenameSelection =>
  selection.typeName !== undefined;

/**
 * The operation narrowed to its root meta fields, beside the document's
 * fragments, which those fields may spread. `undefined` when it selects none.
 */
export const metaDocument = (
  document: DocumentNode,
  operation: OperationDefinitionNode,
): DocumentNode | undefined => {
  const selections = operation.selectionSet.selections.filter(isMetaField);
  if (selections.length === 0) return undefined;

  return {
    kind: Kind.DOCUMENT,
    definitions: [
      { ...operation, selectionSet: { ...operation.selectionSet, selections } },
      ...document.definitions.filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION),
    ],
  };
};

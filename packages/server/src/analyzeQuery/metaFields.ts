import { Kind } from "graphql";

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionNode,
} from "graphql";
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
 * fragments, which those fields may spread. A fragment at the root level is
 * narrowed the same way: graphql-js would resolve the rest of it to nothing.
 * `undefined` when it selects none.
 */
export const metaDocument = (
  document: DocumentNode,
  operation: OperationDefinitionNode,
): DocumentNode | undefined => {
  const fragments = document.definitions.filter(
    (definition): definition is FragmentDefinitionNode =>
      definition.kind === Kind.FRAGMENT_DEFINITION,
  );
  // `null` for a root-level fragment with no meta field, and while one is being
  // walked, which ends a cycle.
  const narrowed = new Map<string, FragmentDefinitionNode | null>();

  const narrowFragment = (name: string): FragmentDefinitionNode | null => {
    const known = narrowed.get(name);
    if (known !== undefined) return known;

    narrowed.set(name, null);
    const fragment = fragments.find((definition) => definition.name.value === name);
    if (!fragment) return null;

    const selections = narrowSelections(fragment.selectionSet.selections);
    const result =
      selections.length > 0
        ? { ...fragment, selectionSet: { ...fragment.selectionSet, selections } }
        : null;
    narrowed.set(name, result);
    return result;
  };

  const narrowSelections = (selections: readonly SelectionNode[]): SelectionNode[] =>
    selections.flatMap<SelectionNode>((selection) => {
      if (selection.kind === Kind.FIELD) return isMetaField(selection) ? [selection] : [];
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        return narrowFragment(selection.name.value) ? [selection] : [];
      }
      const inner = narrowSelections(selection.selectionSet.selections);
      return inner.length > 0
        ? [{ ...selection, selectionSet: { ...selection.selectionSet, selections: inner } }]
        : [];
    });

  const selections = narrowSelections(operation.selectionSet.selections);
  if (selections.length === 0) return undefined;

  return {
    kind: Kind.DOCUMENT,
    definitions: [
      { ...operation, selectionSet: { ...operation.selectionSet, selections } },
      ...fragments.flatMap((fragment) => {
        const atRoot = narrowed.get(fragment.name.value);
        if (atRoot === undefined) return [fragment];
        return atRoot === null ? [] : [atRoot];
      }),
    ],
  };
};

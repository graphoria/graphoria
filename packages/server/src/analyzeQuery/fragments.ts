import { Kind } from "graphql";

import type { DocumentNode, FragmentDefinitionNode } from "graphql";

/**
 * Collect all fragment definitions from a document.
 */
export const collectFragments = (document: DocumentNode): Map<string, FragmentDefinitionNode> => {
  const fragments = new Map<string, FragmentDefinitionNode>();

  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def);
    }
  }

  return fragments;
};

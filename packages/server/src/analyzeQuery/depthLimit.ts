import { GraphQLError, Kind } from "graphql";

import type {
  ASTNode,
  ASTVisitor,
  DocumentNode,
  FragmentDefinitionNode,
  ValidationContext,
} from "graphql";

/**
 * Compute the depth of a selection set, resolving fragment spreads.
 * Introspection fields (__schema, __type, __typename) are excluded.
 */
function computeDepth(
  node: { selectionSet?: { selections: readonly ASTNode[] } },
  fragments: Map<string, FragmentDefinitionNode>,
  depthSoFar: number,
  maxDepth: number,
  visited: Set<string>,
): number {
  if (!node.selectionSet) return depthSoFar;

  let max = depthSoFar;

  for (const selection of node.selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        // Skip introspection meta-fields
        if (selection.name.value.startsWith("__")) continue;

        const fieldDepth = computeDepth(selection, fragments, depthSoFar + 1, maxDepth, visited);

        if (fieldDepth > max) max = fieldDepth;

        // Early exit if already over the limit
        if (max > maxDepth) return max;
        break;
      }

      case Kind.FRAGMENT_SPREAD: {
        const name = selection.name.value;

        // Guard against circular fragments
        if (visited.has(name)) continue;
        visited.add(name);

        const fragment = fragments.get(name);
        if (!fragment) continue;

        const fragmentDepth = computeDepth(fragment, fragments, depthSoFar, maxDepth, visited);

        if (fragmentDepth > max) max = fragmentDepth;
        if (max > maxDepth) return max;
        break;
      }

      case Kind.INLINE_FRAGMENT: {
        const inlineDepth = computeDepth(selection, fragments, depthSoFar, maxDepth, visited);

        if (inlineDepth > max) max = inlineDepth;
        if (max > maxDepth) return max;
        break;
      }
    }
  }

  return max;
}

/**
 * Collect all fragment definitions from a document.
 */
function collectFragments(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();

  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def);
    }
  }

  return fragments;
}

/**
 * GraphQL validation rule that rejects queries exceeding a maximum nesting depth.
 *
 * @param maxDepth - Maximum allowed depth (1 = only top-level fields)
 * @returns A GraphQL ValidationRule
 *
 * @example
 * ```ts
 * import { validate, parse } from "graphql";
 *
 * const errors = validate(schema, parse(query), [depthLimitRule(10)]);
 * ```
 */
export const depthLimitRule =
  (maxDepth: number) =>
  (context: ValidationContext): ASTVisitor => {
    return {
      Document(node) {
        const fragments = collectFragments(node);

        for (const def of node.definitions) {
          if (def.kind !== Kind.OPERATION_DEFINITION) continue;

          const depth = computeDepth(def, fragments, 0, maxDepth, new Set<string>());

          if (depth > maxDepth) {
            const operationName = def.name?.value ?? "anonymous";

            context.reportError(
              new GraphQLError(
                `Query depth of ${depth} exceeds the maximum allowed depth of ${maxDepth} (operation: "${operationName}")`,
                { nodes: [def] },
              ),
            );
          }
        }
      },
    };
  };

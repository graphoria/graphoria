import { GraphQLError, Kind } from "graphql";

import type { ASTNode, ASTVisitor, FragmentDefinitionNode, ValidationContext } from "graphql";

import { collectFragments } from "./fragments";

type DepthWalk = {
  fragments: Map<string, FragmentDefinitionNode>;
  maxDepth: number;
  /** A fragment's depth below its spread, measured once however often it is spread. */
  fragmentDepths: Map<string, number>;
};

function depthOfFragment(name: string, walk: DepthWalk, onPath: Set<string>): number {
  const known = walk.fragmentDepths.get(name);
  if (known !== undefined) return known;

  // A fragment already on the path is a cycle, which validation also rejects.
  if (onPath.has(name)) return 0;

  const fragment = walk.fragments.get(name);
  if (!fragment) return 0;

  onPath.add(name);
  const depth = computeDepth(fragment, 0, walk, onPath);
  onPath.delete(name);

  walk.fragmentDepths.set(name, depth);
  return depth;
}

/**
 * Compute the depth of a selection set, resolving fragment spreads.
 * Introspection fields (__schema, __type, __typename) are excluded.
 */
function computeDepth(
  node: { selectionSet?: { selections: readonly ASTNode[] } },
  depthSoFar: number,
  walk: DepthWalk,
  onPath: Set<string>,
): number {
  if (!node.selectionSet) return depthSoFar;

  let max = depthSoFar;

  for (const selection of node.selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        // Skip introspection meta-fields
        if (selection.name.value.startsWith("__")) continue;

        const fieldDepth = computeDepth(selection, depthSoFar + 1, walk, onPath);

        if (fieldDepth > max) max = fieldDepth;

        // Early exit if already over the limit
        if (max > walk.maxDepth) return max;
        break;
      }

      case Kind.FRAGMENT_SPREAD: {
        const fragmentDepth = depthSoFar + depthOfFragment(selection.name.value, walk, onPath);

        if (fragmentDepth > max) max = fragmentDepth;
        if (max > walk.maxDepth) return max;
        break;
      }

      case Kind.INLINE_FRAGMENT: {
        const inlineDepth = computeDepth(selection, depthSoFar, walk, onPath);

        if (inlineDepth > max) max = inlineDepth;
        if (max > walk.maxDepth) return max;
        break;
      }
    }
  }

  return max;
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
/**
 * Identity, not message matching: a caller classifying a rejection needs to
 * tell this rule's error from an ordinary validation error, and the message is
 * not a contract. Weak so a held error never pins the entry.
 */
const depthErrors = new WeakSet<GraphQLError>();

export const isDepthLimitError = (error: unknown): boolean =>
  error instanceof GraphQLError && depthErrors.has(error);

export const depthLimitRule =
  (maxDepth: number) =>
  (context: ValidationContext): ASTVisitor => {
    return {
      Document(node) {
        const walk = { fragments: collectFragments(node), maxDepth, fragmentDepths: new Map() };

        for (const def of node.definitions) {
          if (def.kind !== Kind.OPERATION_DEFINITION) continue;

          const depth = computeDepth(def, 0, walk, new Set<string>());

          if (depth > maxDepth) {
            const operationName = def.name?.value ?? "anonymous";

            const error = new GraphQLError(
              `Query depth of ${depth} exceeds the maximum allowed depth of ${maxDepth} (operation: "${operationName}"). Raise MAX_QUERY_DEPTH to allow deeper queries.`,
              { nodes: [def] },
            );
            depthErrors.add(error);
            context.reportError(error);
          }
        }
      },
    };
  };

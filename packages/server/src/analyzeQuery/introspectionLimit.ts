import { GraphQLError, Kind } from "graphql";

import type { ASTVisitor, SelectionSetNode, ValidationContext } from "graphql";

// The introspection fields that answer a list. One nested inside itself
// multiplies the answer at every level, and no client needs that: GraphiQL's
// query selects each once per path. `ofType` answers a single type, and a
// wrapped type such as `[Item!]!` nests through it, so it stays free.
const LIST_FIELDS = [
  "types",
  "fields",
  "args",
  "inputFields",
  "interfaces",
  "possibleTypes",
  "enumValues",
];

const BITS = new Map(LIST_FIELDS.map((name, index) => [name, 1 << index]));

/**
 * GraphQL validation rule that refuses a query selecting one introspection list
 * field twice on a path under `__schema` or `__type`. Depth and cost skip
 * introspection fields, so this is what bounds them.
 *
 * @example
 * ```ts
 * import { validate, parse } from "graphql";
 *
 * const errors = validate(schema, parse(query), [introspectionLimitRule]);
 * ```
 */
export const introspectionLimitRule = (context: ValidationContext): ASTVisitor => {
  // A fragment's verdict depends only on the list fields above its spread, so
  // one walk per fragment and path serves every spread of it. Without this, a
  // document whose fragments each spread the next one twice costs 2^n to check.
  const verdicts = new Map<string, string | undefined>();
  const spreading = new Set<string>();

  const repeatedIn = (
    selectionSet: SelectionSetNode | undefined,
    onPath: number,
  ): string | undefined => {
    if (!selectionSet) return undefined;

    for (const selection of selectionSet.selections) {
      let repeated: string | undefined;

      switch (selection.kind) {
        case Kind.FIELD: {
          const bit = BITS.get(selection.name.value) ?? 0;
          if (onPath & bit) return selection.name.value;

          repeated = repeatedIn(selection.selectionSet, onPath | bit);
          break;
        }

        case Kind.INLINE_FRAGMENT: {
          repeated = repeatedIn(selection.selectionSet, onPath);
          break;
        }

        case Kind.FRAGMENT_SPREAD: {
          const name = selection.name.value;
          const key = `${name}:${onPath}`;

          if (verdicts.has(key)) {
            repeated = verdicts.get(key);
            break;
          }

          // A cycle is NoFragmentCyclesRule's to report, a missing fragment
          // KnownFragmentNamesRule's.
          const fragment = context.getFragment(name);
          if (!fragment || spreading.has(name)) break;

          spreading.add(name);
          repeated = repeatedIn(fragment.selectionSet, onPath);
          spreading.delete(name);

          verdicts.set(key, repeated);
          break;
        }
      }

      if (repeated) return repeated;
    }

    return undefined;
  };

  return {
    Field(node) {
      if (node.name.value !== "__schema" && node.name.value !== "__type") return;

      const repeated = repeatedIn(node.selectionSet, 0);

      if (repeated) {
        context.reportError(
          new GraphQLError(
            `Introspection selects "${repeated}" twice on one path under "${node.name.value}". Each of ${LIST_FIELDS.join(", ")} may appear once on a path.`,
            { nodes: [node] },
          ),
        );
      }
    },
  };
};

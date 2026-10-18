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

// graphql-js's MaxIntrospectionDepthRule refuses a path holding three of these.
// This rule keeps that bound in its place: that rule walks a fragment again at
// every spread of it.
const NESTING_FIELDS = ["fields", "interfaces", "possibleTypes", "inputFields"];
const MAX_NESTING = 2;

const BITS = new Map(LIST_FIELDS.map((name, index) => [name, 1 << index]));
const NESTING_MASK = NESTING_FIELDS.reduce((mask, name) => mask | (BITS.get(name) ?? 0), 0);

const countOf = (mask: number): number => {
  let count = 0;
  for (let rest = mask; rest; rest &= rest - 1) count++;
  return count;
};

const BOUND = `Each of ${LIST_FIELDS.join(", ")} may appear once on a path, and at most ${MAX_NESTING} of ${NESTING_FIELDS.join(", ")}.`;

/**
 * GraphQL validation rule that bounds introspection under `__schema` and
 * `__type`: a path selects each list field once at most, and at most two of
 * `fields`, `interfaces`, `possibleTypes` and `inputFields`, the bound of
 * graphql-js's MaxIntrospectionDepthRule, which it replaces. Depth and cost skip
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

  const violationIn = (
    selectionSet: SelectionSetNode | undefined,
    onPath: number,
  ): string | undefined => {
    if (!selectionSet) return undefined;

    for (const selection of selectionSet.selections) {
      let violation: string | undefined;

      switch (selection.kind) {
        case Kind.FIELD: {
          const name = selection.name.value;
          const bit = BITS.get(name) ?? 0;
          if (onPath & bit) return `selects "${name}" twice`;

          const path = onPath | bit;
          if (bit & NESTING_MASK && countOf(path & NESTING_MASK) > MAX_NESTING) {
            const nested = NESTING_FIELDS.filter((field) => path & (BITS.get(field) ?? 0)).map(
              (field) => `"${field}"`,
            );
            return `nests ${nested.slice(0, -1).join(", ")} and ${nested.at(-1)}`;
          }

          violation = violationIn(selection.selectionSet, path);
          break;
        }

        case Kind.INLINE_FRAGMENT: {
          violation = violationIn(selection.selectionSet, onPath);
          break;
        }

        case Kind.FRAGMENT_SPREAD: {
          const name = selection.name.value;
          const key = `${name}:${onPath}`;

          if (verdicts.has(key)) {
            violation = verdicts.get(key);
            break;
          }

          // A cycle is NoFragmentCyclesRule's to report, a missing fragment
          // KnownFragmentNamesRule's.
          const fragment = context.getFragment(name);
          if (!fragment || spreading.has(name)) break;

          spreading.add(name);
          violation = violationIn(fragment.selectionSet, onPath);
          spreading.delete(name);

          verdicts.set(key, violation);
          break;
        }
      }

      if (violation) return violation;
    }

    return undefined;
  };

  return {
    Field(node) {
      if (node.name.value !== "__schema" && node.name.value !== "__type") return;

      const violation = violationIn(node.selectionSet, 0);

      if (violation) {
        context.reportError(
          new GraphQLError(
            `Introspection ${violation} on one path under "${node.name.value}". ${BOUND}`,
            { nodes: [node] },
          ),
        );
      }
    },
  };
};

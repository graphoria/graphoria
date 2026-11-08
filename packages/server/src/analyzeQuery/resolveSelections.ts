import type { MergedEntities } from "../configuration/getSchemas/mergeEntities";
import type { FragmentAnalysis, OperationAnalysis, SelectionAnalysis } from "./types";

import { filterBasedOnDirective } from "../databases/common";
import { CONTROL_FLOW_DIRECTIVES } from "./directiveUtils";
import { META_FIELDS } from "./metaFields";

// A named fragment can be spread under many fields, so a small document can
// describe a tree whose every node the builders walk. MAX_QUERY_COST is off
// unless configured, so this bound holds regardless. It counts each occurrence
// of a field, merged or not, which also caps the work done here.
const MAX_EXPANDED_SELECTIONS = 50_000;

/**
 * Turns analyzed selections into the plain fields execution answers, as the
 * spec's CollectFields does: fragments flatten into the set they sit in,
 * entries `keep` rejects are dropped, and a field selected twice becomes one,
 * its selections merged. The last occurrence supplies its arguments: nothing
 * checks that occurrences agree, and the engine's results are last-write-wins.
 */
export const resolveSelections = (
  selections: SelectionAnalysis[] | undefined,
  fragments: FragmentAnalysis[],
  keep: (selection: SelectionAnalysis) => boolean,
): SelectionAnalysis[] => {
  const fieldsByName = new Map(fragments.map((fragment) => [fragment.name, fragment.fields]));
  let remaining = fragments.length > 0 ? MAX_EXPANDED_SELECTIONS : Number.POSITIVE_INFINITY;

  const collect = (
    entries: SelectionAnalysis[] | undefined,
    groups: Map<string, SelectionAnalysis[]>,
    spread: Set<string>,
  ): void => {
    for (const selection of entries ?? []) {
      if (!keep(selection)) continue;

      if (selection.name.startsWith("... on ")) {
        collect(selection.selections, groups, spread);
      } else if (selection.name.startsWith("...")) {
        const name = selection.name.slice(3);
        if (spread.has(name)) continue;
        spread.add(name);
        collect(fieldsByName.get(name), groups, spread);
      } else {
        if (--remaining < 0) {
          throw new Error(
            `Query too complex: fragments expand to more than ${MAX_EXPANDED_SELECTIONS} selections`,
          );
        }
        const key = selection.alias || selection.name;
        const group = groups.get(key);
        if (group) group.push(selection);
        else groups.set(key, [selection]);
      }
    }
  };

  const resolveSet = (entries: SelectionAnalysis[] | undefined): SelectionAnalysis[] => {
    const groups = new Map<string, SelectionAnalysis[]>();
    collect(entries, groups, new Set());

    return Array.from(groups.values(), (group) => {
      const field = group[group.length - 1]!;
      return field.selections
        ? { ...field, selections: resolveSet(group.flatMap((entry) => entry.selections ?? [])) }
        : field;
    });
  };

  return resolveSet(selections);
};

const needsResolution = (selections: SelectionAnalysis[]): boolean =>
  selections.some(
    (selection) =>
      selection.name.startsWith("...") ||
      selection.directives?.some((directive) => CONTROL_FLOW_DIRECTIVES.has(directive.name)) ===
        true ||
      (selection.selections !== undefined && needsResolution(selection.selections)),
  );

// An analysis is cached per query text, and most documents hold nothing to
// resolve: they should not pay for a walk on every request.
const verdicts = new WeakMap<OperationAnalysis, boolean>();

/**
 * The operation as this request runs it. Before `resolveVariables`, which binds
 * the arguments of the fields it can reach: a field left inside a fragment
 * would keep its `$session.*` claims and role-filter literals unbound.
 */
export const resolveOperationSelections = (
  operation: OperationAnalysis,
  fragments: FragmentAnalysis[],
  variables: Record<string, unknown>,
  entities: Pick<MergedEntities, "getResolverSource">,
): OperationAnalysis => {
  let needed = verdicts.get(operation);
  if (needed === undefined) {
    needed = needsResolution(operation.fields);
    verdicts.set(operation, needed);
  }
  if (!needed) return operation;

  const definitions = operation.variables ?? [];

  return {
    ...operation,
    fields: resolveSelections(operation.fields, fragments, (selection) =>
      filterBasedOnDirective(selection, definitions, variables),
    )
      .filter((field) => !META_FIELDS.has(field.name))
      .map((field) =>
        field.source === undefined
          ? { ...field, source: entities.getResolverSource(field.name) }
          : field,
      ),
  };
};

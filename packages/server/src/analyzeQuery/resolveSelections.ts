import type { MergedEntities } from "../configuration/getSchemas/mergeEntities";
import type {
  FragmentAnalysis,
  OperationAnalysis,
  SelectionAnalysis,
  VariableDefinition,
} from "./types";

import { filterBasedOnDirective } from "../databases/common";
import { CONTROL_FLOW_DIRECTIVES } from "./directiveUtils";
import { META_FIELDS } from "./metaFields";

// A named fragment can be spread under many fields, so a small document can
// describe a tree whose every node the builders walk. MAX_QUERY_COST is off
// unless configured, so this bound holds regardless. It counts each occurrence
// of a field, merged or not, which also caps the work done here.
const MAX_EXPANDED_SELECTIONS = 50_000;

const hasControlFlow = (selection: SelectionAnalysis): boolean =>
  selection.directives?.some((directive) => CONTROL_FLOW_DIRECTIVES.has(directive.name)) === true;

/**
 * Turns analyzed selections into the plain fields execution answers, as the
 * spec's CollectFields does: fragments flatten into the set they sit in,
 * entries `keep` rejects are dropped, and a field selected twice with the same
 * arguments becomes one, its selections merged. Nothing checks that a response
 * key's occurrences agree, and each was validated and priced alone, so one that
 * is another field or has other arguments is dropped rather than merged: the
 * last stands, as the engine's results are last-write-wins. `definitions` holds
 * the values of the literals hoisted from arguments.
 */
export const resolveSelections = (
  selections: SelectionAnalysis[] | undefined,
  fragments: FragmentAnalysis[],
  keep: (selection: SelectionAnalysis) => boolean,
  definitions: VariableDefinition[] = [],
): SelectionAnalysis[] => {
  const fieldsByName = new Map(fragments.map((fragment) => [fragment.name, fragment.fields]));
  let remaining = fragments.length > 0 ? MAX_EXPANDED_SELECTIONS : Number.POSITIVE_INFINITY;

  const literals = new Map(
    definitions
      .filter((definition) => definition.name.startsWith("static_"))
      .map((definition) => [`$${definition.name}`, definition.defaultValue]),
  );

  // Each literal is hoisted to a variable of its own, so arguments compare by
  // what those hold. The order of an object's keys means nothing.
  const argumentValue = (value: unknown): unknown => {
    if (typeof value === "string") return literals.has(value) ? literals.get(value) : value;
    if (Array.isArray(value)) return value.map((item) => argumentValue(item));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, argumentValue(item)]),
    );
  };

  const identity = (field: SelectionAnalysis): string =>
    JSON.stringify([field.name, argumentValue(field.arguments)]);

  const occurrencesOf = (
    last: SelectionAnalysis,
    group: SelectionAnalysis[],
  ): SelectionAnalysis[] => {
    if (group.length === 1) return group;
    const wanted = identity(last);
    return group.filter((entry) => identity(entry) === wanted);
  };

  // `conditional`: under a fragment a directive can exclude, so a field that is
  // non-null in the schema can still be missing from the response.
  const collect = (
    entries: SelectionAnalysis[] | undefined,
    groups: Map<string, SelectionAnalysis[]>,
    spread: Set<string>,
    conditional: boolean,
  ): void => {
    for (const selection of entries ?? []) {
      if (!keep(selection)) continue;

      if (selection.name.startsWith("... on ")) {
        collect(selection.selections, groups, spread, conditional || hasControlFlow(selection));
      } else if (selection.name.startsWith("...")) {
        const name = selection.name.slice(3);
        if (spread.has(name)) continue;
        spread.add(name);
        collect(fieldsByName.get(name), groups, spread, conditional || hasControlFlow(selection));
      } else {
        if (--remaining < 0) {
          throw new Error(
            `Query too complex: fragments expand to more than ${MAX_EXPANDED_SELECTIONS} selections`,
          );
        }
        const entry =
          conditional && selection.isRequired ? { ...selection, isRequired: undefined } : selection;
        const key = selection.alias || selection.name;
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
      }
    }
  };

  const resolveSet = (entries: SelectionAnalysis[] | undefined): SelectionAnalysis[] => {
    const groups = new Map<string, SelectionAnalysis[]>();
    collect(entries, groups, new Set(), false);

    return Array.from(groups.values(), (group) => {
      const last = group[group.length - 1]!;
      const merged = occurrencesOf(last, group);
      const field = merged.some((entry) => entry.isRequired) ? { ...last, isRequired: true } : last;
      return field.selections
        ? { ...field, selections: resolveSet(merged.flatMap((entry) => entry.selections ?? [])) }
        : field;
    });
  };

  return resolveSet(selections);
};

const needsResolution = (selections: SelectionAnalysis[]): boolean =>
  selections.some(
    (selection) =>
      selection.name.startsWith("...") ||
      hasControlFlow(selection) ||
      (selection.selections !== undefined && needsResolution(selection.selections)),
  );

/** The operation a request names, or the document's first when it names none. */
export const selectOperation = (
  operations: OperationAnalysis[],
  name: unknown,
): OperationAnalysis => {
  if (typeof name !== "string" || name === "") return operations[0]!;

  const named = operations.find((operation) => operation.name === name);
  if (!named) throw new Error(`Unknown operation named "${name}".`);
  return named;
};

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
    fields: resolveSelections(
      operation.fields,
      fragments,
      (selection) => filterBasedOnDirective(selection, definitions, variables),
      definitions,
    )
      .filter((field) => !META_FIELDS.has(field.name))
      .map((field) =>
        field.source === undefined
          ? { ...field, source: entities.getResolverSource(field.name) }
          : field,
      ),
  };
};

import { isString } from "es-toolkit";

import type { SessionContext } from "../utils/sessionVariables";
import type {
  OperationAnalysis,
  ResolvedOperation,
  SelectionAnalysis,
  VariableDefinition,
} from "./types";

import { hasSessionVariables, replaceSessionVariables } from "../utils/sessionVariables";

const PRIMITIVE_GRAPHQL_TYPES = new Set(["Int", "Float", "String", "Boolean", "ID"]);

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Resolves a single `$varName` reference against a flat variable map.
 * Returns the resolved value, or the original value if it's not a variable ref.
 */
export const resolveVariableRef = (variables: Record<string, unknown>, value: unknown): unknown => {
  if (!isString(value)) return value;
  if (!value.startsWith("$")) return value;

  const varName = value.substring(1);
  if (variables[varName] === undefined) throw new Error(`Variable ${varName} not found`);
  return variables[varName];
};

// ─── Step 1: Validation ─────────────────────────────────────────────────────

/**
 * Validates that all declared variables have runtime values or defaults.
 * Throws if a required variable is missing.
 */
export const validateVariables = (
  variables: VariableDefinition[] | undefined,
  runtimeVars: Record<string, unknown>,
): void => {
  variables?.forEach((variable) => {
    if (runtimeVars[variable.name] === undefined && variable.defaultValue === undefined) {
      throw new Error(`Missing value for variable: $${variable.name}`);
    }
  });
};

// ─── Step 2: Object Variable Flattening ─────────────────────────────────────

/** Result of flattening object-type variables into static_N primitives. */
export interface FlattenResult {
  /** Map from object var name → transformed object with $static_N refs */
  resolvedMap: Map<string, unknown>;
  /** New VariableDefinition entries for generated static_N vars */
  newStaticVariables: VariableDefinition[];
  /** Runtime values for the generated static_N vars */
  resolvedRuntimeValues: Record<string, unknown>;
  /** Names of object-type variables that were consumed */
  resolvedObjectVarNames: Set<string>;
  /** Variable names referenced via $varName inside object values */
  nestedReferencedVars: Set<string>;
}

/**
 * Extracts primitive values from a runtime object and converts them to static variable references.
 * This mirrors what extractArgumentValue does for AST nodes, but works on resolved JavaScript objects.
 * Ensures primitive values get parameterized in SQL instead of being inlined.
 * Also tracks any nested variable references found within the object.
 */
export const extractRuntimePrimitivesToVariables = (
  obj: unknown,
  generatedVariables: VariableDefinition[],
  runtimeVariables: Record<string, unknown>,
  startIndex: number,
  referencedVariables: Set<string> = new Set(),
  declaredVariableNames?: Set<string>,
): unknown => {
  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle arrays - recurse into each element
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      extractRuntimePrimitivesToVariables(
        item,
        generatedVariables,
        runtimeVariables,
        startIndex,
        referencedVariables,
        declaredVariableNames,
      ),
    );
  }

  // Handle primitives - convert to static variable references
  if (typeof obj === "string") {
    // A `$name` string is a reference only when the document declares that
    // variable. These values arrive from the request body, so anything else
    // beginning with `$` is data the client sent: `$1` resolved to index -1 and
    // emitted the placeholder `$0`, and a value naming a real generated
    // variable would have read that parameter's value instead of matching on
    // its own text.
    if (
      obj.startsWith("$") &&
      (!declaredVariableNames || declaredVariableNames.has(obj.substring(1)))
    ) {
      referencedVariables.add(obj.substring(1));
      return obj;
    }
    const varName = `static_${startIndex + generatedVariables.length}`;
    generatedVariables.push({
      name: varName,
      type: "String",
      required: false,
      defaultValue: obj,
    });
    runtimeVariables[varName] = obj;
    return `$${varName}`;
  }

  if (typeof obj === "number") {
    const varName = `static_${startIndex + generatedVariables.length}`;
    const type = Number.isInteger(obj) ? "Int" : "Float";
    generatedVariables.push({
      name: varName,
      type,
      required: false,
      defaultValue: obj,
    });
    runtimeVariables[varName] = obj;
    return `$${varName}`;
  }

  if (typeof obj === "boolean") {
    const varName = `static_${startIndex + generatedVariables.length}`;
    generatedVariables.push({
      name: varName,
      type: "Boolean",
      required: false,
      defaultValue: obj,
    });
    runtimeVariables[varName] = obj;
    return `$${varName}`;
  }

  // Handle objects - recurse into each property
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = extractRuntimePrimitivesToVariables(
        value,
        generatedVariables,
        runtimeVariables,
        startIndex,
        referencedVariables,
        declaredVariableNames,
      );
    }
    return result;
  }

  return obj;
};

/**
 * Identifies object-type variables from the operation, flattens their primitive
 * leaves into static_N variable references, and returns all resolution artifacts.
 * Pure function — does not mutate the input variable definitions.
 */
export const flattenObjectVariables = (
  variables: VariableDefinition[],
  runtimeVars: Record<string, unknown>,
  existingStaticCount: number,
): FlattenResult => {
  const newStaticVariables: VariableDefinition[] = [];
  const resolvedRuntimeValues: Record<string, unknown> = {};
  const resolvedObjectVarNames = new Set<string>();
  const nestedReferencedVars = new Set<string>();
  const resolvedMap = new Map<string, unknown>();
  const declaredVariableNames = new Set(variables.map((variable) => variable.name));

  for (const varDef of variables) {
    if (varDef.name.startsWith("static_")) continue;
    if (PRIMITIVE_GRAPHQL_TYPES.has(varDef.type)) continue;

    const value = runtimeVars[varDef.name];
    if (value === undefined || typeof value !== "object" || value === null) {
      continue;
    }

    resolvedObjectVarNames.add(varDef.name);

    const transformed = extractRuntimePrimitivesToVariables(
      value,
      newStaticVariables,
      resolvedRuntimeValues,
      existingStaticCount,
      nestedReferencedVars,
      declaredVariableNames,
    );

    resolvedMap.set(varDef.name, transformed);
  }

  return {
    resolvedMap,
    newStaticVariables,
    resolvedRuntimeValues,
    resolvedObjectVarNames,
    nestedReferencedVars,
  };
};

// ─── Step 3: Immutable Field Resolution ─────────────────────────────────────

/**
 * Where late-resolved values are turned into bound parameters.
 *
 * Client-supplied argument values are hoisted into `static_N` variables while
 * the document is analyzed, so by the time they reach the query builders they
 * are `$name` references the builders emit as placeholders. Two classes of
 * value never went through that hoisting, because they are not in the document:
 * the constants written into a role's permission filter, and the claim values
 * `$session.*` resolves to. Both were interpolated into the SQL text verbatim.
 */
export type VariableSink = {
  generatedVariables: VariableDefinition[];
  runtimeVariables: Record<string, unknown>;
  startIndex: number;
};

const typeOfValue = (value: unknown): string => {
  if (typeof value === "number") return Number.isInteger(value) ? "Int" : "Float";
  if (typeof value === "boolean") return "Boolean";
  return "String";
};

/** Binds one value as a fresh `static_N` variable and returns its reference. */
const parameterize = (sink: VariableSink, value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  // An array operand (`in`) is bound element-wise: the builders emit one
  // placeholder per element.
  if (Array.isArray(value)) return value.map((item) => parameterize(sink, item));

  if (typeof value === "object") return value;

  const name = `static_${sink.startIndex + sink.generatedVariables.length}`;

  sink.generatedVariables.push({
    name,
    type: typeOfValue(value),
    required: false,
    defaultValue: value as never,
  });
  sink.runtimeVariables[name] = value;

  return `$${name}`;
};

/**
 * Replaces `$session.*` placeholders in any argument value.
 * Walks all arguments, not just `where`.
 *
 * Substituted claim values are bound as parameters on the way out. Doing it
 * here rather than in the `where` pass below matters: a claim whose value
 * happens to begin with `$` would otherwise be indistinguishable from a
 * variable reference, and would resolve to some other parameter's value.
 */
const resolveSessionInArguments = (
  args: Record<string, unknown>,
  session: SessionContext,
  sink?: VariableSink,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const onResolved = sink ? (value: unknown) => parameterize(sink, value) : undefined;

  for (const [key, value] of Object.entries(args)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      hasSessionVariables(value as Record<string, unknown>)
    ) {
      result[key] = replaceSessionVariables(value as Record<string, unknown>, session, onResolved);
    } else {
      result[key] = value;
    }
  }

  return result;
};

/**
 * Binds every literal still sitting in a `where` argument.
 *
 * Only `where` is walked. `orderBy` carries direction enums and `limit`/`offset`
 * are consumed by the pagination builder, and neither is emitted as a bound
 * value, so parameterizing them would change the SQL rather than protect it.
 */
const parameterizeWhereLiterals = (value: unknown, sink: VariableSink): unknown => {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map((item) => parameterizeWhereLiterals(item, sink));

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        parameterizeWhereLiterals(nested, sink),
      ]),
    );
  }

  // Already a reference — the analyzer hoisted it out of the document.
  if (isString(value) && value.startsWith("$")) return value;

  return parameterize(sink, value);
};

/**
 * Recursively replaces `$varName` references with their resolved (already-flattened) values from
 * `resolvedMap`, walking nested objects/arrays so a reference nested inside an inline argument
 * object (e.g. `where: { rel: { sub: $where } }`) is substituted like a top-level one. The resolved
 * value is inserted as-is — it is not walked further, so its own `$static_N` leaves survive for SQL
 * parameter binding. Refs absent from `resolvedMap` (scalar vars, `$session.*`) pass through.
 */
const substituteResolvedRefs = (value: unknown, resolvedMap: Map<string, unknown>): unknown => {
  if (isString(value)) {
    if (value.startsWith("$")) {
      const varName = value.substring(1);
      if (resolvedMap.has(varName)) return resolvedMap.get(varName);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteResolvedRefs(item, resolvedMap));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = substituteResolvedRefs(nested, resolvedMap);
    }
    return result;
  }

  return value;
};

/**
 * Returns a new field tree with:
 * 1. `$varName` argument references replaced with their resolved objects from `resolvedMap`
 * 2. `$session.*` placeholders replaced with actual JWT claim values in ALL arguments
 *
 * Does NOT mutate the input fields — returns a new array.
 */
export const resolveFieldArguments = (
  fields: SelectionAnalysis[],
  resolvedMap: Map<string, unknown>,
  session?: SessionContext,
  sink?: VariableSink,
): SelectionAnalysis[] => {
  return fields.map((field) => {
    let newArguments = field.arguments;

    if (field.arguments) {
      // Shallow-copy arguments so we don't mutate originals
      newArguments = { ...field.arguments };

      // Replace object variable references anywhere in arguments — top-level (`where: $where`) or
      // nested inside an inline object (`where: { rel: { sub: $where } }`). Only walk when there is
      // something to substitute so the session-only path stays a no-op.
      if (resolvedMap.size > 0) {
        for (const [key, value] of Object.entries(newArguments)) {
          newArguments[key] = substituteResolvedRefs(value, resolvedMap);
        }
      }

      // Replace session variables in ALL argument values (not just where)
      if (session) {
        newArguments = resolveSessionInArguments(newArguments, session, sink);
      }

      // Bind whatever literals remain in `where`. After the two passes above the
      // only ones left are the constants a role filter was configured with.
      if (sink && newArguments["where"] !== undefined) {
        newArguments["where"] = parameterizeWhereLiterals(newArguments["where"], sink);
      }
    }

    // Recurse into nested selections
    const newSelections = field.selections
      ? resolveFieldArguments(field.selections, resolvedMap, session, sink)
      : field.selections;

    // Only create a new field object if something changed
    if (newArguments !== field.arguments || newSelections !== field.selections) {
      return {
        ...field,
        arguments: newArguments,
        selections: newSelections,
      };
    }

    return field;
  });
};

// ─── Step 4: Variable List Rebuilding ───────────────────────────────────────

/** Result of rebuilding the final variable list and values. */
interface BuildFinalResult {
  variables: VariableDefinition[];
  allVariables: Record<string, unknown>;
}

/**
 * Produces the rebuilt variable definition list and merged flat variable map.
 * - Removes consumed object-type variable definitions
 * - Preserves nested $ref variable definitions
 * - Appends generated static_N definitions
 * - Merges defaults → runtime → generated values (in override order)
 */
export const buildFinalVariables = (
  originalVars: VariableDefinition[],
  flattenResult: FlattenResult,
  runtimeVars: Record<string, unknown>,
): BuildFinalResult => {
  const {
    newStaticVariables,
    resolvedObjectVarNames,
    nestedReferencedVars,
    resolvedRuntimeValues,
  } = flattenResult;

  const variables = [
    ...originalVars.filter(
      (v) => !resolvedObjectVarNames.has(v.name) || nestedReferencedVars.has(v.name),
    ),
    ...newStaticVariables,
  ];

  // Merge: defaults → runtime → generated static values
  const allVariables = {
    ...variables.reduce<Record<string, unknown>>((acc, variable) => {
      if (variable.defaultValue !== undefined) {
        acc[variable.name] = variable.defaultValue;
      }
      return acc;
    }, {}),
    ...runtimeVars,
    ...resolvedRuntimeValues,
  };

  return { variables, allVariables };
};

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Resolves an operation's variables in a single pass:
 * 1. Validates that all declared variables have values or defaults
 * 2. Flattens object-type variables into static_N primitive references
 * 3. Produces new fields with argument references and session variables resolved
 * 4. Builds the final variable list and merged value map
 *
 * Returns a `ResolvedOperation` — the input `operation` is NEVER mutated.
 */
export const resolveVariables = (
  operation: OperationAnalysis,
  variables: Record<string, unknown>,
  session?: SessionContext,
): ResolvedOperation => {
  // 1. Validate
  validateVariables(operation.variables, variables);

  // 2. Flatten object-type variables
  const hasVars = operation.variables && operation.variables.length > 0;

  if (!hasVars) {
    // A document with no variables of its own can still carry a role filter,
    // whose constants and session values both need binding.
    const sink: VariableSink = {
      generatedVariables: [],
      runtimeVariables: {},
      startIndex: 0,
    };

    const fields = resolveFieldArguments(operation.fields, new Map(), session, sink);

    return {
      fields,
      variables: [...(operation.variables ?? []), ...sink.generatedVariables],
      allVariables: { ...variables, ...sink.runtimeVariables },
    };
  }

  const existingStaticCount = operation.variables!.filter((v) =>
    v.name.startsWith("static_"),
  ).length;

  const flattenResult = flattenObjectVariables(
    operation.variables!,
    variables,
    existingStaticCount,
  );

  // 3. Resolve field arguments (immutable)
  // Numbering continues past the statics flattening just produced, so the two
  // passes cannot mint the same name.
  const sink: VariableSink = {
    generatedVariables: [],
    runtimeVariables: {},
    startIndex: existingStaticCount + flattenResult.newStaticVariables.length,
  };

  const fields = resolveFieldArguments(operation.fields, flattenResult.resolvedMap, session, sink);

  // 4. Build final variable list and merged values
  const { variables: resolvedVarDefs, allVariables } = buildFinalVariables(
    operation.variables!,
    flattenResult,
    variables,
  );

  const finalVarDefs = resolvedVarDefs.length > 0 ? resolvedVarDefs : operation.variables!;

  return {
    fields,
    // Appended, never reordered: the builders emit `$n` from a definition's
    // index in this list, and the driver binds it from the same list.
    variables: [...finalVarDefs, ...sink.generatedVariables],
    allVariables: { ...allVariables, ...sink.runtimeVariables },
  };
};

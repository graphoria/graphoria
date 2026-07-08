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
      ),
    );
  }

  // Handle primitives - convert to static variable references
  if (typeof obj === "string") {
    if (obj.startsWith("$")) {
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
 * Replaces `$session.*` placeholders in any argument value.
 * Walks all arguments, not just `where`.
 */
const resolveSessionInArguments = (
  args: Record<string, unknown>,
  session: SessionContext,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      hasSessionVariables(value as Record<string, unknown>)
    ) {
      result[key] = replaceSessionVariables(value as Record<string, unknown>, session);
    } else {
      result[key] = value;
    }
  }

  return result;
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
): SelectionAnalysis[] => {
  return fields.map((field) => {
    let newArguments = field.arguments;

    if (field.arguments) {
      // Shallow-copy arguments so we don't mutate originals
      newArguments = { ...field.arguments };

      // Replace object variable references in arguments
      for (const [key, value] of Object.entries(newArguments)) {
        if (isString(value) && value.startsWith("$")) {
          const varName = value.substring(1);
          if (resolvedMap.has(varName)) {
            newArguments[key] = resolvedMap.get(varName);
          }
        }
      }

      // Replace session variables in ALL argument values (not just where)
      if (session) {
        newArguments = resolveSessionInArguments(newArguments, session);
      }
    }

    // Recurse into nested selections
    const newSelections = field.selections
      ? resolveFieldArguments(field.selections, resolvedMap, session)
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
    // No variable definitions — still need to resolve session variables in fields
    const fields = session
      ? resolveFieldArguments(operation.fields, new Map(), session)
      : operation.fields;

    return {
      fields,
      variables: operation.variables ?? [],
      allVariables: { ...variables },
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
  const fields =
    flattenResult.resolvedMap.size > 0 || session
      ? resolveFieldArguments(operation.fields, flattenResult.resolvedMap, session)
      : operation.fields;

  // 4. Build final variable list and merged values
  const { variables: resolvedVarDefs, allVariables } = buildFinalVariables(
    operation.variables!,
    flattenResult,
    variables,
  );

  return {
    fields,
    variables: resolvedVarDefs.length > 0 ? resolvedVarDefs : operation.variables!,
    allVariables,
  };
};

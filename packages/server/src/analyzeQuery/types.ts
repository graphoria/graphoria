import type { EntitySource } from "../types/resolver";

export interface AnalysisResult {
  operations: OperationAnalysis[];
  fragments: FragmentAnalysis[];
}

export interface OperationAnalysis {
  name: string | null;
  operation: "query" | "mutation" | "subscription";
  variables?: VariableDefinition[];
  fields: SelectionAnalysis[];
}

export interface FragmentAnalysis {
  name: string;
  typeCondition: string;
  fields: SelectionAnalysis[];
}

export interface SelectionAnalysis {
  name: string;
  alias?: string;
  /** The source of this field (table, queue, auth, operation, etc.) */
  source?: EntitySource;
  // oxlint-disable-next-line typescript/no-explicit-any
  arguments?: { [key: string]: any };
  selections?: SelectionAnalysis[];
  isArray?: boolean;
  directives?: DirectiveAnalysis[];
  isRequired?: boolean;
}

export interface DirectiveAnalysis {
  name: string;
  arguments?: { [key: string]: unknown };
}

export interface VariableDefinition {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
}

/**
 * The result of resolving variables for an operation.
 * This is an immutable snapshot — the original OperationAnalysis is never mutated.
 */
export interface ResolvedOperation {
  /** Fields with all $varName references and $session.* placeholders resolved */
  fields: SelectionAnalysis[];
  /** Rebuilt variable definitions (object vars replaced with static_N entries) */
  variables: VariableDefinition[];
  /** Flat map of all variable values: defaults → runtime → generated static values */
  allVariables: Record<string, unknown>;
}

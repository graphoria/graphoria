import type { VariableDefinition } from "../../analyzeQuery/types";
import type { ProcedureResolver } from "../../types/db";

/**
 * Orders a procedure call's arguments for the engines that bind positionally.
 *
 * `$1, $2, …` are numbered by one list and filled from another, so the two have
 * to be the same list or the values land on the wrong parameters. Signature
 * order comes from the introspected metadata; the caller's argument object is
 * unordered and reflects the GraphQL query text.
 *
 * Arguments the metadata doesn't account for keep their supplied order and
 * follow: an unnamed procedure parameter is introspected under a synthesized
 * name that no caller can match, and dropping the value there would be worse
 * than binding it where it was already going.
 */
export const orderProcedureArguments = (
  sp: ProcedureResolver,
  variables: Record<string, unknown>,
): VariableDefinition[] => {
  const declared = sp.parameters.map((p) => p.name).filter((name) => name in variables);
  const undeclared = Object.keys(variables).filter((name) => !declared.includes(name));

  return [...declared, ...undeclared].map((name) => ({ name, type: "", required: false }));
};

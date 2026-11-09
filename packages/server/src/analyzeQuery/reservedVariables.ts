import { GraphQLError } from "graphql";

import type { ASTVisitor, ValidationContext } from "graphql";

import { isHoistedName } from "./valueExtractors";

/**
 * Refuses a declared variable named like a hoisted literal. The analysis writes
 * both as `$static_N`, so it would be bound and compared as that literal while
 * the limits priced the value the request sent.
 */
export const reservedVariableNamesRule = (context: ValidationContext): ASTVisitor => ({
  VariableDefinition(node) {
    const name = node.variable.name.value;
    if (!isHoistedName(name)) return;

    context.reportError(
      new GraphQLError(
        `Variable "$${name}" uses a reserved name: static_N names are generated for literals.`,
        { nodes: [node] },
      ),
    );
  },
});

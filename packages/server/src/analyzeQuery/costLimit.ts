import { GraphQLError, GraphQLObjectType, Kind } from "graphql";

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
  ValueNode,
} from "graphql";

import { collectFragments } from "./fragments";
import { getFieldType, unwrapType } from "./typeUtils";

/**
 * Page bounds the estimate is drawn against. `maxPageSize` is carried, not read:
 * a resolved limit above it is rejected at execution, so the walk never has to
 * clamp — but the estimator needs it the day that ordering changes.
 */
export type CostPageLimits = {
  defaultPageSize: number;
  maxPageSize: number;
};

type WalkContext = {
  schema: GraphQLSchema;
  variables: Record<string, unknown>;
  pageLimits: CostPageLimits;
  fragments: Map<string, FragmentDefinitionNode>;
  // A fragment's cost depends only on its own body and type condition, so one
  // expansion serves every spread of it. Without this a document whose
  // fragments each spread the next one twice costs 2^n to estimate.
  fragmentCosts: Map<string, number>;
};

// Resolve an argument to a number, following a variable into the runtime values.
// Mirrors `resolveLimitValue` in databases/common.ts so the estimate and the
// page-size cap agree on what "resolves to a number" means.
const resolveIntValue = (
  value: ValueNode | undefined,
  variables: Record<string, unknown>,
): number | undefined => {
  if (!value) return undefined;

  if (value.kind === Kind.INT) return Number.parseInt(value.value, 10);

  if (value.kind === Kind.VARIABLE) {
    const resolved = variables[value.name.value];
    return typeof resolved === "number" ? resolved : undefined;
  }

  return undefined;
};

// How many rows a field's children are paid for. Only a list field multiplies:
// a to-one relationship, a single-row field and a scalar each cost their subtree
// once.
const multiplierFor = (field: FieldNode, isArray: boolean, ctx: WalkContext): number => {
  if (!isArray) return 1;

  const limit = field.arguments?.find((argument) => argument.name.value === "limit")?.value;

  return resolveIntValue(limit, ctx.variables) ?? ctx.pageLimits.defaultPageSize;
};

const objectTypeNamed = (schema: GraphQLSchema, name: string): GraphQLObjectType | undefined => {
  const type = schema.getType(name);
  return type instanceof GraphQLObjectType ? type : undefined;
};

const costOfFragment = (name: string, ctx: WalkContext, onPath: Set<string>): number => {
  const memoised = ctx.fragmentCosts.get(name);
  if (memoised !== undefined) return memoised;

  // A fragment already on the path is a cycle. `validate` rejects those before
  // the estimate runs; cutting here only keeps a hand-built document finite.
  if (onPath.has(name)) return 0;

  const fragment = ctx.fragments.get(name);
  if (!fragment) return 0;

  onPath.add(name);
  const cost = costOfSelectionSet(
    fragment.selectionSet,
    objectTypeNamed(ctx.schema, fragment.typeCondition.name.value),
    ctx,
    onPath,
  );
  onPath.delete(name);

  ctx.fragmentCosts.set(name, cost);
  return cost;
};

/**
 * `cost(field) = 1 + multiplier(field) × Σ cost(child)`, summed across the
 * selection set. An unresolved parent type costs its children once — the
 * estimate degrades, it does not throw.
 */
const costOfSelectionSet = (
  selectionSet: SelectionSetNode | undefined,
  parentType: GraphQLObjectType | undefined,
  ctx: WalkContext,
  onPath: Set<string>,
): number => {
  if (!selectionSet) return 0;

  let total = 0;

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        if (selection.name.value.startsWith("__")) continue;

        const fieldType = parentType ? getFieldType(parentType, selection.name.value) : undefined;
        const unwrapped = fieldType ? unwrapType(fieldType) : undefined;
        const childType = unwrapped?.type instanceof GraphQLObjectType ? unwrapped.type : undefined;

        const children = costOfSelectionSet(selection.selectionSet, childType, ctx, onPath);

        total += 1 + multiplierFor(selection, unwrapped?.isArray ?? false, ctx) * children;
        break;
      }

      case Kind.FRAGMENT_SPREAD: {
        total += costOfFragment(selection.name.value, ctx, onPath);
        break;
      }

      case Kind.INLINE_FRAGMENT: {
        const condition = selection.typeCondition
          ? objectTypeNamed(ctx.schema, selection.typeCondition.name.value)
          : parentType;

        total += costOfSelectionSet(selection.selectionSet, condition, ctx, onPath);
        break;
      }
    }
  }

  return total;
};

const rootTypeFor = (
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
): GraphQLObjectType | undefined => {
  switch (operation.operation) {
    case "mutation":
      return schema.getMutationType() ?? undefined;
    case "subscription":
      return schema.getSubscriptionType() ?? undefined;
    default:
      return schema.getQueryType() ?? undefined;
  }
};

const costliestOperation = (
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown>,
  pageLimits: CostPageLimits,
): { cost: number; operation: OperationDefinitionNode | undefined } => {
  const ctx: WalkContext = {
    schema,
    variables,
    pageLimits,
    fragments: collectFragments(document),
    fragmentCosts: new Map(),
  };

  let worst: { cost: number; operation: OperationDefinitionNode | undefined } = {
    cost: 0,
    operation: undefined,
  };

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;

    const cost = costOfSelectionSet(
      definition.selectionSet,
      rootTypeFor(schema, definition),
      ctx,
      new Set<string>(),
    );

    if (cost > worst.cost || worst.operation === undefined) {
      worst = { cost, operation: definition };
    }
  }

  return worst;
};

/**
 * Estimate how many rows a document asks a database for, before executing it.
 *
 * Every field costs 1 for itself plus the cost of its children multiplied by the
 * page size it requests — the `limit` argument for a list field, resolved through
 * `variables`, falling back to `defaultPageSize`; 1 for anything that returns a
 * single row. Fragment spreads are expanded, so moving a fan-out into a fragment
 * does not hide it.
 *
 * A document carrying several operations is scored by its most expensive one:
 * a request executes one of them.
 */
export const estimateQueryCost = (
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown>,
  pageLimits: CostPageLimits,
): number => costliestOperation(document, schema, variables, pageLimits).cost;

/**
 * Reject a document whose estimated cost exceeds `maxCost`. Returns `null` when
 * it is within budget.
 */
export const checkQueryCost = (
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown>,
  pageLimits: CostPageLimits,
  maxCost: number,
): GraphQLError | null => {
  const { cost, operation } = costliestOperation(document, schema, variables, pageLimits);

  if (cost <= maxCost) return null;

  const operationName = operation?.name?.value ?? "anonymous";

  return new GraphQLError(
    `Estimated query cost of ${cost} exceeds the maximum allowed cost of ${maxCost} (operation: "${operationName}"). Raise MAX_QUERY_COST to allow more expensive queries.`,
    { nodes: operation ? [operation] : undefined },
  );
};

import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from "graphql";

import type { FieldNode, SelectionNode } from "graphql";
import type { MergedEntities } from "../../configuration/getSchemas/mergeEntities";
import type { SelectionAnalysis, VariableDefinition } from "../types";

import { analyzeDirectives } from "../directiveUtils";
import { getFieldType, unwrapType } from "../typeUtils";
import { extractArgumentValue } from "../valueExtractors";

export const analyzeSelections = (
  selections: readonly SelectionNode[],
  parentType: GraphQLObjectType,
  entities: MergedEntities,
  gqlSchema: GraphQLSchema,
  declaredVariables: VariableDefinition[],
  generatedVariables: VariableDefinition[],
): SelectionAnalysis[] =>
  selections
    .map((selection) => {
      if (selection.kind === "Field") {
        const field = selection as FieldNode;

        const isGqlQuery = entities.queriesMap[field.name.value] !== undefined;

        let args = field.arguments
          ? Object.fromEntries(
              field.arguments.map((arg) => [
                arg.name.value,
                extractArgumentValue(arg.value, isGqlQuery ? generatedVariables : undefined),
              ]),
            )
          : undefined;

        const fieldName = field.name.value;
        if (fieldName === "__typename") {
          return {
            name: fieldName,
          };
        }
        const fieldType = getFieldType(parentType, fieldName);
        let isArray = false;
        let fieldObjType: GraphQLObjectType | null = null;

        if (fieldType) {
          const unwrapped = unwrapType(fieldType);
          isArray = unwrapped.isArray;
          if (unwrapped.type instanceof GraphQLObjectType) {
            fieldObjType = unwrapped.type;
          }
        }

        const hasDirectives = field.directives && field.directives.length > 0;

        const directives = analyzeDirectives(field.directives || [], generatedVariables);

        const isRequired =
          fieldType instanceof GraphQLNonNull &&
          directives.filter(
            (dir) => dir.name === "include" || dir.name === "skip" || dir.name === "when",
          ).length === 0;

        // Gated on the field resolving to a table type, not on it being a list.
        // A role filter has to reach every field backed by the table it
        // restricts: the `_single` root field and any to-one relationship both
        // return one object, and both accept a `where` the builders honour, so
        // skipping them let a caller read a row the filter excludes by asking
        // for it singly or by traversing into it from an unfiltered table.
        if (fieldObjType && entities.queriesMap[fieldName]?.rolePermission?.filter) {
          if (!args) {
            args = {
              where: entities.queriesMap[fieldName].rolePermission?.filter,
            };
          } else {
            args = {
              ...args,
              where: {
                ...(args.where || {}),
                ...entities.queriesMap[fieldName].rolePermission?.filter,
              },
            };
          }
        }

        const selectionAnalysis: SelectionAnalysis = {
          name: fieldName,
          ...(field.alias && { alias: field.alias.value }),
          ...(args && Object.keys(args).length && { arguments: args }),
          ...(isArray && { isArray }),
          ...(hasDirectives && { directives }),
          ...(field.selectionSet &&
            fieldObjType && {
              selections: analyzeSelections(
                field.selectionSet.selections,
                fieldObjType,
                entities,
                gqlSchema,
                declaredVariables,
                generatedVariables,
              ),
            }),
          ...(isRequired && { isRequired }),
        };
        return selectionAnalysis;
      } else if (selection.kind === "FragmentSpread") {
        return {
          name: `...${selection.name.value}`,
          ...(selection.directives &&
            selection.directives.length > 0 && {
              directives: analyzeDirectives(selection.directives, generatedVariables),
            }),
        };
      } else if (selection.kind === "InlineFragment") {
        const typeCondition =
          selection.typeCondition &&
          (gqlSchema.getType(selection.typeCondition.name.value) as GraphQLObjectType);

        return {
          name: `... on ${selection.typeCondition?.name.value}`,
          ...(selection.directives &&
            selection.directives.length > 0 && {
              directives: analyzeDirectives(selection.directives, generatedVariables),
            }),
          selections:
            selection.selectionSet && typeCondition
              ? analyzeSelections(
                  selection.selectionSet.selections,
                  typeCondition,
                  entities,
                  gqlSchema,
                  declaredVariables,
                  generatedVariables,
                )
              : undefined,
        };
      } else {
        return {
          name: "UnknownSelection",
        };
      }
    })
    .filter((sel) => sel.name !== "__typename");

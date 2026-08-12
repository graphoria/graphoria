import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from "graphql";

import type { GraphQLType, TypeNode } from "graphql";

export const getFieldType = (
  parentType: GraphQLObjectType,
  fieldName: string,
): GraphQLType | undefined => {
  const fields = parentType.getFields();
  const field = fields[fieldName];
  return field ? field.type : undefined;
};

export const unwrapType = (
  type: GraphQLType,
): {
  type: GraphQLType;
  isArray: boolean;
} => {
  let isArray = false;

  while (true) {
    if (type instanceof GraphQLNonNull) {
      type = type.ofType;
    } else if (type instanceof GraphQLList) {
      isArray = true;
      type = type.ofType;
    } else {
      break;
    }
  }

  return { type, isArray };
};

export const processType = (typeNode: TypeNode): string => {
  switch (typeNode.kind) {
    case "NonNullType":
      return `${processType(typeNode.type)}!`;
    case "ListType":
      return `[${processType(typeNode.type)}]`;
    case "NamedType":
      return typeNode.name.value;
    default:
      return "Unknown";
  }
};

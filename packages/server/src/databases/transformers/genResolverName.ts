import { sanitizeGraphQLName } from "./graphqlName";

export const genResolverName = (
  schema: string,
  name: string,
  type: "table" | "view" | "sp",
  fieldNaming: string = "{schema}_{name}",
  dbName: string = "",
  suffix?: string,
) => {
  const baseName = fieldNaming
    .replace("{database}", dbName)
    .replace("{type}", type)
    .replace("{schema}", schema)
    .replace("{name}", name);

  return sanitizeGraphQLName(suffix ? `${baseName}_${suffix}` : baseName);
};

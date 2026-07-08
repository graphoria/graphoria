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

  if (suffix) return `${baseName}_${suffix}`;

  return baseName;
};

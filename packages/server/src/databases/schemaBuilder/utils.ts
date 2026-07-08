export const splitInternalName = (internalName: string, helpers: boolean = false) => {
  const [schema, ...nameSegments] = internalName.split("_");

  const name = nameSegments.join("_");

  return {
    schema,
    name,
    ...(helpers
      ? {
          nameDashed: `${schema}_${name}`,
          nameDotted: `${schema}.${name}`,
          nameDottedQuoted: `"${schema}"."${name}"`,
        }
      : {}),
  };
};

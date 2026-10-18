/**
 * A `__type` query whose fragments each spread the next one twice: a validation
 * walk that follows every spread visits 2^levels of them.
 */
export const fragmentFanOut = (levels: number, typeName: string): string =>
  [
    `{ __type(name: "${typeName}") { ...F0 } }`,
    ...Array.from(
      { length: levels },
      (_, level) => `fragment F${level} on __Type { ...F${level + 1} ...F${level + 1} }`,
    ),
    `fragment F${levels} on __Type { name }`,
  ].join("\n");

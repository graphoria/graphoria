import { format } from "oxfmt";

import type { AnalyzedConfiguration } from "../configuration/index.ts";

export const schemaFileName = (role: string) => `schema_${role}.graphql`;

export const formatSchema = async (typeDefs: string) =>
  (await format("schema.graphql", typeDefs)).code;

export const writeSchema = async (
  roles: AnalyzedConfiguration["roles"],
  outputDir: string,
): Promise<void> => {
  await Promise.all(
    Object.entries(roles).map(async ([role, schema]) =>
      Bun.write(`${outputDir}/${schemaFileName(role)}`, await formatSchema(schema.typeDefs)),
    ),
  );
};

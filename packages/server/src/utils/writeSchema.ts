import { format } from "oxfmt";

import type { AnalyzedConfiguration } from "../configuration/index.ts";

export const writeSchema = async (
  roles: AnalyzedConfiguration["roles"],
  outputDir: string,
): Promise<void> => {
  Object.entries(roles).forEach(async ([role, schema]) => {
    const { code } = await format("schema.graphql", schema.typeDefs);
    await Bun.write(`${outputDir}/schema_${role}.graphql`, code);
  });
};

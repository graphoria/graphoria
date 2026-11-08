import type { SelectionAnalysis } from "../analyzeQuery/types";

import { isTypename } from "../analyzeQuery/metaFields";

export const filterResultBySelection = (
  data: unknown,
  fields: SelectionAnalysis[] | undefined,
): unknown => {
  if (!fields) return data;

  if (Array.isArray(data)) {
    return data.map((item) => filterResultBySelection(item, fields));
  }

  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
      const key = field.name;
      const alias = field.alias || key;

      if (isTypename(field)) {
        result[alias] = field.typeName;
      } else if (key in (data as Record<string, unknown>)) {
        result[alias] = filterResultBySelection(
          (data as Record<string, unknown>)[key],
          field.selections,
        );
      }
    }

    return result;
  }

  return data;
};

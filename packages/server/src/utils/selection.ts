import type { SelectionAnalysis } from "../analyzeQuery/types";

export const filterResultBySelection = (
  data: unknown,
  fields: SelectionAnalysis[] | undefined,
): unknown => {
  if (!fields || fields.length === 0) return data;

  if (Array.isArray(data)) {
    return data.map((item) => filterResultBySelection(item, fields));
  }

  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};

    for (const field of fields) {
      const key = field.name;
      const alias = field.alias || key;

      if (key in (data as Record<string, unknown>)) {
        const value = (data as Record<string, unknown>)[key];

        if (field.selections && field.selections.length > 0) {
          result[alias] = filterResultBySelection(value, field.selections);
        } else {
          result[alias] = value;
        }
      }
    }

    return result;
  }

  return data;
};

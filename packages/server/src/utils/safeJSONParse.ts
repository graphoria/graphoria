import { logger } from "../logging";

export const safeJSONParse = <T = Record<string, unknown>>(jsonString: string): T => {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    logger("utils").warn({ err: error }, "failed to parse JSON");
    return {} as T;
  }
};

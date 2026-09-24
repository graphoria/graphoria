import { parseArgs } from "util";

import type { DatabaseType } from "../config";

export type InitArgs = {
  yes: boolean;
  database?: DatabaseType;
  install: boolean;
};

export const DATABASE_TYPES: readonly DatabaseType[] = ["pg", "mysql", "mssql"];

export const isDatabaseType = (value: string): value is DatabaseType =>
  (DATABASE_TYPES as readonly string[]).includes(value);

export const parseInitArgs = (argv: string[]): InitArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      database: { type: "string", short: "d" },
      install: { type: "boolean", default: true },
    },
    allowNegative: true,
    strict: true,
  });

  if (values.database !== undefined && !isDatabaseType(values.database)) {
    throw new Error(`--database must be one of ${DATABASE_TYPES.join(", ")}`);
  }

  return {
    yes: values.yes,
    ...(values.database !== undefined && { database: values.database }),
    install: values.install,
  };
};

import { parseArgs } from "util";

import type { DatabaseType } from "../config";

export type InitArgs = {
  yes: boolean;
  database?: DatabaseType;
  dbName?: string;
  dbPort?: number;
  rabbitmq?: boolean;
  ai?: boolean;
  redis?: boolean;
  frontend?: boolean;
  install: boolean;
};

export const DATABASE_TYPES: readonly DatabaseType[] = ["pg", "mysql", "mssql", "sqlite"];

export const isDatabaseType = (value: string): value is DatabaseType =>
  (DATABASE_TYPES as readonly string[]).includes(value);

export const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export const dbNameError = (answer: string): string | undefined =>
  DB_NAME.test(answer)
    ? undefined
    : "Use lowercase letters, digits and _, not starting with a digit, up to 63 characters.";

export const portError = (answer: string): string | undefined => {
  const port = Number(answer);
  return /^\d+$/.test(answer) && port >= 1 && port <= 65535
    ? undefined
    : "Use a port number from 1 to 65535.";
};

export const parseInitArgs = (argv: string[]): InitArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      database: { type: "string", short: "d" },
      "db-name": { type: "string" },
      "db-port": { type: "string" },
      rabbitmq: { type: "boolean" },
      ai: { type: "boolean" },
      redis: { type: "boolean" },
      frontend: { type: "boolean" },
      install: { type: "boolean", default: true },
    },
    allowNegative: true,
    strict: true,
  });

  if (values.database !== undefined && !isDatabaseType(values.database)) {
    throw new Error(`--database must be one of ${DATABASE_TYPES.join(", ")}`);
  }

  const dbNameReason = values["db-name"] !== undefined ? dbNameError(values["db-name"]) : undefined;
  if (dbNameReason) throw new Error(`--db-name: ${dbNameReason}`);

  const dbPortReason = values["db-port"] !== undefined ? portError(values["db-port"]) : undefined;
  if (dbPortReason) throw new Error(`--db-port: ${dbPortReason}`);

  return {
    yes: values.yes,
    ...(values.database !== undefined && { database: values.database }),
    ...(values["db-name"] !== undefined && { dbName: values["db-name"] }),
    ...(values["db-port"] !== undefined && { dbPort: Number(values["db-port"]) }),
    ...(values.rabbitmq !== undefined && { rabbitmq: values.rabbitmq }),
    ...(values.ai !== undefined && { ai: values.ai }),
    ...(values.redis !== undefined && { redis: values.redis }),
    ...(values.frontend !== undefined && { frontend: values.frontend }),
    install: values.install,
  };
};

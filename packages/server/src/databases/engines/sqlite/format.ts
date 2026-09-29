import { format as sqlFormatter } from "sql-formatter";

export const format = (sql: string) =>
  sqlFormatter(sql, {
    language: "sqlite",
    paramTypes: { custom: [{ regex: String.raw`\$\d+` }] },
  });

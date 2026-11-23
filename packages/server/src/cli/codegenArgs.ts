import { parseArgs } from "util";

export type CodegenArgs = { config?: string; out?: string };

export const CODEGEN_USAGE = "Usage: graphoria codegen [--config <path>] [--out <dir>]";

export const parseCodegenArgs = (argv: string[]): CodegenArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c" },
      out: { type: "string" },
    },
    strict: true,
  });

  return { config: values.config, out: values.out };
};

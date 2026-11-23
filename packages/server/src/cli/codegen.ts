import { readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isString } from "es-toolkit/compat";

import type { Configuration } from "../types/configuration";
import type { CodegenArgs } from "./codegenArgs";

import { analyzeConfiguration, assertDistinctRoles, loadConfiguration } from "../configuration";
import { logger } from "../logging";
import { disconnectDatabases, instantiateDatabasesConnections } from "../singletons/databases";
import { env } from "../singletons/env";
import { ConfigurationZod } from "../types/zod/configuration";
import { formatSchema, schemaFileName } from "../utils/writeSchema";
import { CODEGEN_USAGE, parseCodegenArgs } from "./codegenArgs";

export type CodegenResult = { written: string[] };

const SCHEMA_FILE = /^schema_.+\.graphql$/;
const OPENAPI_FILE = /^openapi_.+\.json$/;

// The analysis builds a store for every cached operation, and a Redis store
// connects when it is built. No output reads `cache`.
const withoutCaches = (configuration: Configuration): Configuration => ({
  ...configuration,
  operations: Object.fromEntries(
    Object.entries(configuration.operations).map(([name, operation]) => [
      name,
      { ...operation, cache: undefined },
    ]),
  ),
});

const leftOutNames = ({
  remoteSchemas,
  remoteREST,
}: {
  remoteSchemas: string[];
  remoteREST: string[];
}) => [
  ...remoteSchemas.map((name) => `remote schema "${name}"`),
  ...remoteREST.map((name) => `remote REST API "${name}"`),
];

const writeOutput = async (path: string, contents: string) => {
  try {
    await Bun.write(path, contents);
  } catch (error) {
    throw new Error(
      `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// A stale schema would keep gql.tada typing against a role that no longer exists.
const prune = async (dir: string, pattern: RegExp, written: Map<string, string>) => {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (pattern.test(name) && !written.has(path)) await rm(path);
  }
};

export const runCodegen = async (args: CodegenArgs): Promise<CodegenResult> => {
  assertDistinctRoles(env);
  if (env.leftoverSchemasOutputDir) {
    logger("codegen").warn(
      "SCHEMAS_OUTPUT_DIR is deprecated and codegen ignores it: codegen writes under OUTPUT_DIR, or --out",
    );
  }

  const configPath =
    args.config ?? (isString(env.configuration) ? env.configuration : "./graphoria.ts");
  const configuration = withoutCaches(ConfigurationZod.parse(await loadConfiguration(configPath)));

  // No setQueryTimeoutMs, unlike the boot: with a timeout set, every SQLite
  // connection logs a warn, and an in-process run would leave the process-wide
  // timeout to whatever runs next.
  try {
    await instantiateDatabasesConnections(configuration.enabledDatabases, env.dbConnectRetryMs);
    const analyzed = await analyzeConfiguration(configuration, env);

    const leftOut = leftOutNames(analyzed.leftOutRemotes);
    if (leftOut.length) {
      throw new Error(
        `${leftOut.join(", ")} did not resolve: nothing was written, since the outputs would leave ${leftOut.length === 1 ? "it" : "them"} out`,
      );
    }

    const outDir = resolve(args.out ?? env.outputDir);
    const files = new Map<string, string>();
    for (const [role, { typeDefs }] of Object.entries(analyzed.roles)) {
      files.set(join(outDir, "schemas", schemaFileName(role)), await formatSchema(typeDefs));
      files.set(
        join(outDir, "openapi", `openapi_${role}.json`),
        `${JSON.stringify(analyzed.openapiFor(role), null, 2)}\n`,
      );
    }

    for (const [path, contents] of files) await writeOutput(path, contents);
    await prune(join(outDir, "schemas"), SCHEMA_FILE, files);
    await prune(join(outDir, "openapi"), OPENAPI_FILE, files);

    return { written: [...files.keys()] };
  } finally {
    await disconnectDatabases();
  }
};

export const summaryLines = (result: CodegenResult, cwd: string): string[] =>
  result.written.map((path) => `wrote ${relative(cwd, path)}`);

export const codegenCommand = async (argv: string[]): Promise<void> => {
  const log = logger("cli");
  let args: CodegenArgs;
  try {
    args = parseCodegenArgs(argv);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, `codegen: ${msg}`);
    console.error(CODEGEN_USAGE);
    process.exit(2);
  }

  try {
    for (const line of summaryLines(await runCodegen(args), process.cwd())) console.log(line);
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, `codegen failed: ${msg}`);
    process.exit(1);
  }
};

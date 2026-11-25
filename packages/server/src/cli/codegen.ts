import { readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isString } from "es-toolkit/compat";
import { format } from "oxfmt";

import type { Configuration } from "../types/configuration";
import type { CodegenArgs } from "./codegenArgs";
import type { Paint } from "./paint";

import { analyzeConfiguration, assertDistinctRoles, loadConfiguration } from "../configuration";
import { logger } from "../logging";
import { disconnectDatabases, instantiateDatabasesConnections } from "../singletons/databases";
import { env } from "../singletons/env";
import { ConfigurationZod } from "../types/zod/configuration";
import { formatSchema, schemaFileName } from "../utils/writeSchema";
import { CODEGEN_USAGE, parseCodegenArgs } from "./codegenArgs";
import { operationOutputs, renderOperationTypes } from "./operationTypes";
import { PLAIN_PAINT, paintFor } from "./paint";
import { formatDuration } from "./progress";

export type CodegenResult = {
  roles: string[];
  schemasDir: string;
  openapiDir: string;
  types: { path: string; operations?: number };
};

export type CodegenDependencies = {
  /** Test seam: whether @trpc/server resolves, as the server's tRPC loader checks it. */
  trpcResolves?: () => boolean;
};

const trpcServerResolves = () => {
  try {
    import.meta.resolve("@trpc/server");
    return true;
  } catch {
    return false;
  }
};

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

export const runCodegen = async (
  args: CodegenArgs,
  { trpcResolves = trpcServerResolves }: CodegenDependencies = {},
): Promise<CodegenResult> => {
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
    const schemasDir = join(outDir, "schemas");
    const openapiDir = join(outDir, "openapi");
    const files = new Map<string, string>();
    for (const [role, { typeDefs }] of Object.entries(analyzed.roles)) {
      files.set(join(schemasDir, schemaFileName(role)), await formatSchema(typeDefs));
      files.set(
        join(openapiDir, `openapi_${role}.json`),
        `${JSON.stringify(analyzed.openapiFor(role), null, 2)}\n`,
      );
    }

    // Beside the config, where its `import type {} from "./graphoria-env"` looks.
    const typesPath = resolve(
      args.types ?? join(dirname(resolve(configPath)), "graphoria-env.d.ts"),
    );
    let operations: number | undefined;
    // Only @graphoria/server/trpc reads the file, and it needs the optional peer.
    if (trpcResolves()) {
      const outputs = operationOutputs(analyzed.roles[env.superadmin.role]!);
      operations = Object.keys(outputs).length;
      files.set(
        typesPath,
        (await format("graphoria-env.d.ts", renderOperationTypes(outputs))).code,
      );
    }

    for (const [path, contents] of files) await writeOutput(path, contents);
    await prune(schemasDir, SCHEMA_FILE, files);
    await prune(openapiDir, OPENAPI_FILE, files);

    return {
      roles: Object.keys(analyzed.roles),
      schemasDir,
      openapiDir,
      types: { path: typesPath, operations },
    };
  } finally {
    await disconnectDatabases();
  }
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const summaryLines = (
  { roles, schemasDir, openapiDir, types }: CodegenResult,
  cwd: string,
  ms: number,
  paint: Paint = PLAIN_PAINT,
): string[] => {
  const row = (label: string, path: string, note?: string) =>
    `  ${paint.success("✓")} ${label.padEnd(20)}${paint.code(path)}${note ? ` ${paint.dim(note)}` : ""}`;
  return [
    `${paint.accent(paint.name("graphoria codegen"))}  ${paint.dim(`${plural(roles.length, "role")}:`)} ${roles.join(", ")}`,
    "",
    row("GraphQL schemas", `${relative(cwd, schemasDir)}/`),
    row("OpenAPI documents", `${relative(cwd, openapiDir)}/`),
    types.operations === undefined
      ? paint.dim(`  – ${"tRPC output types".padEnd(20)}skipped: @trpc/server is not installed`)
      : row(
          "tRPC output types",
          relative(cwd, types.path),
          `(${plural(types.operations, "operation")})`,
        ),
    "",
    paint.dim(`  Done in ${formatDuration(ms)}`),
  ];
};

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
    const started = performance.now();
    const result = await runCodegen(args);
    const lines = summaryLines(
      result,
      process.cwd(),
      performance.now() - started,
      paintFor(process.stdout),
    );
    console.log(lines.join("\n"));
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, `codegen failed: ${msg}`);
    process.exit(1);
  }
};

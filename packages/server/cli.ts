#!/usr/bin/env bun
import { parseArgs } from "util";

import { version } from "./package.json";
import { createSupervisor } from "./src/cli/supervisor";

const rawArgs = Bun.argv.slice(2);

// Loaded on demand: seed-auth reaches the env singleton, which rejects a missing
// ADMIN_SECRET at import, and --help or --version must run without one.
if (rawArgs[0] === "seed-auth") {
  const { seedAuthCommand } = await import("./src/cli/seedAuth");
  await seedAuthCommand(rawArgs.slice(1));
}

if (rawArgs[0] === "init") {
  const { initCommand } = await import("./src/cli/init");
  await initCommand(rawArgs.slice(1));
}

const { values } = parseArgs({
  args: rawArgs,
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    cluster: { type: "boolean", short: "C" },
    workers: { type: "string", short: "w" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  strict: true,
});

if (values.help) {
  console.log(
    `
graphoria v${version}

Usage: graphoria [options]
       graphoria seed-auth --user <name> --password <pwd> --role <role> [--config <path>] [--claims <json>]
       graphoria init [--yes] [--database pg|mysql|mssql] [--frontend] [--no-install]

Options:
  -c, --config <path>    Path to configuration file (env: CONFIGURATION)
  -p, --port <number>    Server port (env: PORT, default: 3000)
  -C, --cluster          Run in cluster mode (auto-detect CPU cores)
  -w, --workers <N>      Number of cluster workers (implies --cluster)
  -h, --help             Show this help message
  -v, --version          Show version number

Subcommands:
  seed-auth              Insert an auth user (argon2id-hashed) into the configured auth database
  init                   Scaffold a Graphoria project with Docker Compose in the current directory

Environment variables:
  ADMIN_SECRET           Admin secret for superadmin access (required)
  JWT_SECRET             JWT signing secret (required with auth or the console)
  CONFIGURATION          Path to configuration file
  PORT                   Server port (default: 3000)
  NODE_ENV               Environment mode (default: DEVELOPMENT)
  ANONYMOUS_ROLE         Default unauthenticated role (default: anonymous)
  GRAPHQL_API_ENDPOINT   GraphQL endpoint path (default: /graphql)
  REST_API_PREFIX        REST API prefix (default: /rest)
  CORS_ENABLED           Enable CORS (default: true)
`.trim(),
  );
  process.exit(0);
}

if (values.version) {
  console.log(version);
  process.exit(0);
}

const standaloneScript = `${import.meta.dir}/standalone.ts`;
const cmd: string[] = ["bun", standaloneScript];
if (values.config) cmd.push("--config", values.config);
if (values.port) cmd.push("--port", values.port);

const clustered = values.cluster || values.workers;
if (clustered) cmd.push("--reuse-port");
const requested = values.workers ? parseInt(values.workers, 10) : NaN;
const clusterSize =
  Number.isNaN(requested) || requested <= 0 ? navigator.hardwareConcurrency : requested;
const workers = clustered ? clusterSize : 1;

const supervisor = createSupervisor({
  workers,
  // Detached: the terminal's Ctrl-C reaches only this process, which passes
  // each worker exactly one SIGTERM. A second signal would force its exit.
  spawn: () =>
    Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit", stdin: "inherit", detached: true }),
});
supervisor.start();

if (clustered) console.log(`🚀 Cluster started with ${workers} workers`);

// SIGHUP too: detached workers no longer get the terminal's hang-up.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => supervisor.signal());
}
process.on("exit", () => supervisor.kill());

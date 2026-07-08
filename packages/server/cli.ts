#!/usr/bin/env bun
import { parseArgs } from "util";

import { seedAuthCommand } from "./src/cli/seedAuth";
import { version } from "./package.json";

const rawArgs = Bun.argv.slice(2);

if (rawArgs[0] === "seed-auth") {
  await seedAuthCommand(rawArgs.slice(1));
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

Options:
  -c, --config <path>    Path to configuration file (env: CONFIGURATION)
  -p, --port <number>    Server port (env: PORT, default: 3000)
  -C, --cluster          Run in cluster mode (auto-detect CPU cores)
  -w, --workers <N>      Number of cluster workers (implies --cluster)
  -h, --help             Show this help message
  -v, --version          Show version number

Subcommands:
  seed-auth              Insert an auth user (argon2id-hashed) into the configured auth database

Environment variables:
  ADMIN_SECRET           Admin secret for superadmin access (required)
  JWT_SECRET             JWT signing secret (required)
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

if (values.cluster || values.workers) {
  cmd.push("--reuse-port");
  const requested = values.workers ? parseInt(values.workers, 10) : NaN;
  const workers =
    Number.isNaN(requested) || requested <= 0 ? navigator.hardwareConcurrency : requested;

  const children = Array.from({ length: workers }, () =>
    Bun.spawn({
      cmd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }),
  );

  console.log(`🚀 Cluster started with ${workers} workers`);

  function kill() {
    for (const child of children) {
      child.kill();
    }
  }

  process.on("SIGINT", kill);
  process.on("exit", kill);
} else {
  const child = Bun.spawn({
    cmd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  process.on("SIGINT", () => child.kill());
  process.on("exit", () => child.kill());
}

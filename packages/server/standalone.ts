#!/usr/bin/env bun
import { parseArgs } from "node:util";

// Minimal arg parsing so standalone.ts works both as a cluster worker
// (args forwarded by cli.ts) and as a direct invocation.
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string", short: "p" },
    "reuse-port": { type: "boolean" },
  },
  strict: true,
  allowPositionals: true,
});

// Set CLI overrides on process.env BEFORE importing server code,
// so EnvZod.parse(process.env) picks them up through the existing Zod pipeline.
if (values.config) process.env.CONFIGURATION = values.config;
if (values.port) process.env.PORT = values.port;

const { exitOnSignalDuringBoot } = await import("./src/shutdown.ts");
const releaseBootSignals = exitOnSignalDuringBoot();

const { createHandlers } = await import("./src/index.ts");

const { serverHandlers, handleSignals } = await createHandlers();
releaseBootSignals();

const server = Bun.serve({
  ...serverHandlers,
  reusePort: values["reuse-port"] ?? false,
});
handleSignals(server);

const { logger } = await import("./src/logging/index.ts");
logger("graphoria").info({ port: server.port }, "server ready");

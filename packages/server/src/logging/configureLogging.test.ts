import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The pino root is process state, and `bun test` runs every file in one
 * process: each case runs in a fresh `bun` that has logged nothing yet.
 */

const SERVER_SRC = join(import.meta.dir, "..");
const PINO = Bun.resolveSync("pino", import.meta.dir);
const WARNING =
  "custom logger ignored: a logger was created before configureLogging or Env.logger took effect, so the default logger stays in use; pass Env.logger to the process's first boot, or call configureLogging before it";

type Line = { level: number; component?: string; msg: string };

let dir: string;

beforeAll(async () => {
  // No .env and no bunfig.toml there: the script reads only the env it is given.
  dir = await mkdtemp(join(tmpdir(), "graphoria-configure-logging-"));
});

afterAll(() => rm(dir, { recursive: true, force: true }));

/**
 * Runs `body` in a fresh process. `custom(name)` makes a pino logger whose
 * lines `lines[name]` collects; `stdout` holds what the default root wrote.
 */
const inFreshProcess = (body: string) => {
  const script = `const { default: pino } = await import(${JSON.stringify(PINO)});
const src = (path) => import(${JSON.stringify(SERVER_SRC)} + "/" + path);
const lines = {};
const custom = (name) =>
  pino({ level: "info" }, { write: (line) => (lines[name] ??= []).push(JSON.parse(line)) });
${body}
console.log(JSON.stringify({ lines }));
process.exit(0);`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH!,
      ADMIN_SECRET: "configure-logging-test",
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      AUTH_STORE: "memory",
      RATE_LIMIT_STORE: "memory",
    },
  });
  if (run.exitCode !== 0) {
    throw new Error(`the script exited ${run.exitCode}: ${run.stderr.toString()}`);
  }

  const output = run.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return {
    stdout: output.slice(0, -1) as Line[],
    lines: (output.at(-1) as { lines: Record<string, Line[]> }).lines,
  };
};

describe("configureLogging", () => {
  it("warns once, through the default root, when a logger was asked for first", () => {
    const { stdout, lines } =
      inFreshProcess(`const { configureLogging, logger } = await src("logging/index.ts");
logger("early").info("before");
configureLogging(custom("custom"));
logger("late").info("after");`);

    expect(stdout.map(({ level, component, msg }) => ({ level, component, msg }))).toEqual([
      { level: 30, component: "early", msg: "before" },
      { level: 40, component: "logging", msg: WARNING },
      { level: 30, component: "late", msg: "after" },
    ]);
    expect(lines.custom).toBeUndefined();
  });

  it("stays silent when an earlier configureLogging set the root", () => {
    const { stdout, lines } =
      inFreshProcess(`const { configureLogging, logger } = await src("logging/index.ts");
configureLogging(custom("first"));
configureLogging(custom("second"));
logger("late").info("after");`);

    expect(stdout).toEqual([]);
    expect(lines.first?.map((line) => line.msg)).toEqual(["after"]);
    expect(lines.second).toBeUndefined();
  });

  it("takes effect after the boot-time signal handler is set up", () => {
    const { stdout, lines } =
      inFreshProcess(`const { exitOnSignalDuringBoot } = await src("shutdown.ts");
const { configureLogging, logger } = await src("logging/index.ts");
exitOnSignalDuringBoot()();
configureLogging(custom("custom"));
logger("late").info("after");`);

    expect(stdout).toEqual([]);
    expect(lines.custom?.map((line) => line.msg)).toEqual(["after"]);
  });

  it("takes effect after the package is imported", () => {
    const { stdout, lines } = inFreshProcess(`await src("index.ts");
const { configureLogging, logger } = await src("logging/index.ts");
configureLogging(custom("custom"));
logger("late").info("after");`);

    expect(stdout).toEqual([]);
    expect(lines.custom?.map((line) => line.msg)).toEqual(["after"]);
  });
});

describe("Env.logger", () => {
  it.each(["createGraphQLEngine", "createHandlers", "createBunServer"])(
    "receives the boot's lines in %s",
    (factory) => {
      const { stdout, lines } = inFreshProcess(`const graphoria = await src("index.ts");
await graphoria.${factory}({
  logger: custom("custom"),
  port: 0,
  configuration: {
    name: "configure-logging-test",
    version: "1.0.0",
    databases: [
      { name: "default", enabled: true, type: "sqlite", connection: { filename: ":memory:" } },
    ],
  },
});`);

      expect(stdout).toEqual([]);
      expect(lines.custom?.map((line) => line.msg)).toContain("starting configuration analysis");
    },
    15_000,
  );
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { version } from "./package.json";

let dir: string;
let configPath: string;
const spawned: number[] = [];

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const childrenOf = (pid: number) =>
  Bun.spawnSync(["pgrep", "-P", String(pid)])
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map(Number);

const startCli = async (args: string[], workers: number) => {
  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "--config", configPath, ...args], {
    env: { ...process.env, ADMIN_SECRET: "cli-test", JWT_SECRET: "cli-test", PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  });
  spawned.push(cli.pid);

  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of cli.stdout) {
    output += decoder.decode(chunk);
    if (output.split("server ready").length > workers) break;
  }

  const children = childrenOf(cli.pid);
  spawned.push(...children);
  expect(children).toHaveLength(workers);
  return { cli, children };
};

const waitUntilGone = async (pids: number[]) => {
  const deadline = Date.now() + 5_000;
  while (pids.some(isAlive) && Date.now() < deadline) await Bun.sleep(50);
  return pids.filter(isAlive);
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-cli-"));
  configPath = join(dir, "graphoria.ts");
  await writeFile(configPath, `export default () => ({ name: "cli-test", version: "1.0.0" });\n`);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

afterEach(() => {
  for (const pid of spawned.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGKILL");
});

describe("cli without env", () => {
  const run = (args: string[]) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

  it("prints the version", () => {
    const result = run(["--version"]);

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(version);
  });

  it("prints the help", () => {
    const result = run(["--help"]);

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: graphoria");
    expect(result.stdout.toString()).toContain("[--frontend]");
  });
});

describe("cli init", () => {
  const FILES = [
    ".dockerignore",
    ".env",
    ".gitignore",
    "Dockerfile",
    "docker-compose.yml",
    "graphoria.ts",
    "index.ts",
    "package.json",
    "seed.sql",
    "tsconfig.json",
  ];

  const init = async (args: string[], stdin?: string) => {
    const cwd = await mkdtemp(join(tmpdir(), "graphoria-cli-init-"));
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "init", ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    });
    return { cwd, result };
  };

  const env = async (cwd: string) =>
    Object.fromEntries(
      (await readFile(join(cwd, ".env"), "utf8"))
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

  const cwds: string[] = [];
  afterAll(() => Promise.all(cwds.map((cwd) => rm(cwd, { recursive: true, force: true }))));

  it("scaffolds a project with every default", async () => {
    const { cwd, result } = await init(["--yes", "--no-install"]);
    cwds.push(cwd);

    expect(result.exitCode).toBe(0);
    expect((await readdir(cwd)).sort()).toEqual(FILES);
    const values = await env(cwd);
    expect(values.ADMIN_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(values.JWT_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(values).toMatchObject({ DB_USER: "postgres", DB_NAME: "app", DB_PORT: "5432" });
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toEqual({
      "@graphoria/server": `^${version}`,
    });
  });

  it("adds the React frontend with --frontend", async () => {
    const { cwd, result } = await init(["--yes", "--frontend", "--no-install"]);
    cwds.push(cwd);

    expect(result.exitCode).toBe(0);
    expect((await readdir(cwd, { recursive: true })).sort()).toEqual(
      [
        ...FILES,
        "bunfig.toml",
        "web",
        "web/App.tsx",
        "web/frontend.tsx",
        "web/graphql.ts",
        "web/index.html",
        "web/styles.css",
      ].sort(),
    );
    expect(result.stdout.toString()).toContain("bun run types");
  });

  it("writes nothing when a frontend file it would create exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "graphoria-cli-init-"));
    cwds.push(cwd);
    await mkdir(join(cwd, "web"));
    await writeFile(join(cwd, "web", "App.tsx"), "mine");
    const result = Bun.spawnSync(
      ["bun", join(import.meta.dir, "cli.ts"), "init", "--yes", "--frontend", "--no-install"],
      { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("web/App.tsx");
    expect((await readdir(cwd, { recursive: true })).sort()).toEqual(["web", "web/App.tsx"]);
    expect(await readFile(join(cwd, "web", "App.tsx"), "utf8")).toBe("mine");
  });

  it("reads the answers from stdin", async () => {
    const { cwd, result } = await init(["--no-install"], "mysql\nshop\n\n13306\n");
    cwds.push(cwd);

    expect(result.exitCode).toBe(0);
    expect(await env(cwd)).toMatchObject({ DB_USER: "root", DB_NAME: "shop", DB_PORT: "13306" });
  });

  it("writes nothing when a file it would create exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "graphoria-cli-init-"));
    cwds.push(cwd);
    await writeFile(join(cwd, "package.json"), "{}");
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "init", "--yes"], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("package.json");
    expect(await readdir(cwd)).toEqual(["package.json"]);
    expect(await readFile(join(cwd, "package.json"), "utf8")).toBe("{}");
  });

  it("rejects an unknown engine as a usage error", async () => {
    const { cwd, result } = await init(["--database", "oracle"]);
    cwds.push(cwd);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Usage: graphoria init");
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("cli SIGTERM", () => {
  it("stops the server process", async () => {
    const { cli, children } = await startCli([], 1);

    cli.kill("SIGTERM");
    await cli.exited;

    expect(await waitUntilGone(children)).toEqual([]);
  }, 30_000);

  it("stops every cluster worker", async () => {
    const { cli, children } = await startCli(["--workers", "2"], 2);

    cli.kill("SIGTERM");
    await cli.exited;

    expect(await waitUntilGone(children)).toEqual([]);
  }, 30_000);
});

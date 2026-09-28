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

/** Reads a child's stdout on demand, so a test can wait for more lines later. */
const readOutput = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    /** The port of every worker that logged "server ready" so far. */
    readyPorts: () =>
      text
        .split("\n")
        .filter((line) => line.includes('"server ready"'))
        .map((line) => (JSON.parse(line) as { port: number }).port),
    waitFor: async (marker: string, count: number) => {
      while (text.split(marker).length <= count) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`output ended before ${count} × "${marker}"`);
        text += decoder.decode(value);
      }
    },
  };
};

const startCli = async (
  args: string[],
  workers: number,
  { detached = false, config = configPath } = {},
) => {
  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "--config", config, ...args], {
    env: { ...process.env, ADMIN_SECRET: "cli-test", JWT_SECRET: "cli-test", PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
    detached,
  });
  spawned.push(cli.pid);

  const output = readOutput(cli.stdout);
  await output.waitFor("server ready", workers);

  const children = childrenOf(cli.pid);
  spawned.push(...children);
  expect(children).toHaveLength(workers);
  return { cli, children, output };
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
  it("stops the server process, then exits 0", async () => {
    const { cli, children } = await startCli([], 1);

    cli.kill("SIGTERM");

    expect(await cli.exited).toBe(0);
    expect(await waitUntilGone(children)).toEqual([]);
  }, 30_000);

  it("stops every cluster worker, then exits 0", async () => {
    const { cli, children } = await startCli(["--workers", "2"], 2);

    cli.kill("SIGTERM");

    expect(await cli.exited).toBe(0);
    expect(await waitUntilGone(children)).toEqual([]);
  }, 30_000);

  it("hands the worker one signal when Ctrl-C reaches the whole process group", async () => {
    const slow = join(dir, "slow.ts");
    await writeFile(
      slow,
      `export default () => ({
  name: "cli-test",
  version: "1.0.0",
  auth: { enabled: false, database: "", permissions: { anonymous: { operations: "ALL" } } },
  operations: {
    slow: {
      handler: async () => {
        await Bun.sleep(1000);
        return { slow: true };
      },
      rest: { path: "/slow", method: "GET" },
    },
  },
});
`,
    );
    const { cli, children, output } = await startCli([], 1, { detached: true, config: slow });
    const port = output.readyPorts()[0];
    const inFlight = Bun.fetch(`http://localhost:${port}/rest/slow`).then(
      (response) => response.status,
      () => "reset",
    );
    await Bun.sleep(200);

    // A worker that got the group's SIGINT and the parent's SIGTERM while
    // draining would take the second as forced, and exit 1.
    process.kill(-cli.pid, "SIGINT");

    expect(await inFlight).toBe(200);
    expect(await cli.exited).toBe(0);
    expect(await waitUntilGone(children)).toEqual([]);
  }, 30_000);
});

describe("cli supervisor", () => {
  it("restarts a worker that dies", async () => {
    const { cli, children, output } = await startCli(["--workers", "2"], 2);

    process.kill(children[0]!, "SIGKILL");
    await output.waitFor("server ready", 3);

    const now = childrenOf(cli.pid);
    spawned.push(...now);
    expect(now).toHaveLength(2);
    expect(now).not.toContain(children[0]);
    expect(now).toContain(children[1]);
  }, 30_000);

  it("gives up with a non-zero exit when every worker crashes at boot", async () => {
    const broken = join(dir, "broken.ts");
    await writeFile(broken, `export default () => { throw new Error("broken config"); };\n`);
    const cli = Bun.spawn(
      ["bun", join(import.meta.dir, "cli.ts"), "--config", broken, "--workers", "5"],
      {
        env: { ...process.env, ADMIN_SECRET: "cli-test", JWT_SECRET: "cli-test", PORT: "0" },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    spawned.push(cli.pid);

    expect(await cli.exited).toBe(1);
  }, 30_000);
});

describe("standalone SIGTERM", () => {
  it("drains the server, then exits 0", async () => {
    const server = Bun.spawn(
      ["bun", join(import.meta.dir, "standalone.ts"), "--config", configPath],
      {
        env: { ...process.env, ADMIN_SECRET: "cli-test", JWT_SECRET: "cli-test", PORT: "0" },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    spawned.push(server.pid);

    const decoder = new TextDecoder();
    let output = "";
    for await (const chunk of server.stdout) {
      output += decoder.decode(chunk);
      if (output.includes("server ready")) break;
    }

    server.kill("SIGTERM");

    expect(await server.exited).toBe(0);
    expect(server.signalCode).toBeNull();
  }, 30_000);
});

describe("signal during boot", () => {
  const RETRYING = "database connect failed, retrying";
  let unreachable: string;
  let boot: string;

  beforeAll(async () => {
    unreachable = join(dir, "unreachable.ts");
    await writeFile(
      unreachable,
      `export default () => ({
  name: "boot-test",
  version: "1.0.0",
  databases: [
    {
      name: "down",
      enabled: true,
      type: "pg",
      connection: { host: "127.0.0.1", port: 1, user: "u", password: "p", database: "d" },
    },
  ],
});
`,
    );

    boot = join(dir, "boot.ts");
    await writeFile(
      boot,
      `import { createBunServer } from ${JSON.stringify(join(import.meta.dir, "src", "index.ts"))};\n\nawait createBunServer();\n`,
    );
  });

  // LOG_LEVEL is explicit: other test files set it to "silent" in this process,
  // and the child would inherit that and never print the marker.
  const spawnBooting = (command: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn(command, {
      env: {
        ...process.env,
        ADMIN_SECRET: "cli-test",
        JWT_SECRET: "cli-test",
        PORT: "0",
        CONFIGURATION: unreachable,
        DB_CONNECT_RETRY_MS: "30000",
        LOG_LEVEL: "info",
        ...env,
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    spawned.push(child.pid);
    return { child, output: readOutput(child.stdout) };
  };

  it("createBunServer exits 0 at once", async () => {
    const { child, output } = spawnBooting(["bun", boot]);
    await output.waitFor(RETRYING, 1);

    const signalledAt = Date.now();
    child.kill("SIGTERM");

    expect(await child.exited).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(Date.now() - signalledAt).toBeLessThan(2_000);
  }, 30_000);

  it("leaves the signal alone with SHUTDOWN_HANDLE_SIGNALS=false", async () => {
    const { child, output } = spawnBooting(["bun", boot], { SHUTDOWN_HANDLE_SIGNALS: "false" });
    await output.waitFor(RETRYING, 1);

    child.kill("SIGTERM");
    await child.exited;

    expect(child.signalCode).toBe("SIGTERM");
  }, 30_000);

  it("a standalone worker exits 0 at once", async () => {
    const { child, output } = spawnBooting([
      "bun",
      join(import.meta.dir, "standalone.ts"),
      "--config",
      unreachable,
    ]);
    await output.waitFor(RETRYING, 1);

    child.kill("SIGTERM");

    expect(await child.exited).toBe(0);
    expect(child.signalCode).toBeNull();
  }, 30_000);
});

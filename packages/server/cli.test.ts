import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

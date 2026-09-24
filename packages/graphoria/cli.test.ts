import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import server from "../server/package.json";
import wrapper from "./package.json";

const cwds: string[] = [];
afterAll(() => Promise.all(cwds.map((cwd) => rm(cwd, { recursive: true, force: true }))));

const run = async (args: string[]) => {
  const cwd = await mkdtemp(join(tmpdir(), "graphoria-wrapper-"));
  cwds.push(cwd);
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  return { cwd, result };
};

describe("graphoria", () => {
  it("runs the @graphoria/server CLI", async () => {
    const { result } = await run(["--version"]);

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(server.version);
  });

  it("scaffolds a project with init", async () => {
    const { cwd, result } = await run(["init", "--yes", "--no-install"]);

    expect(result.exitCode).toBe(0);
    expect(await readdir(cwd)).toContain("graphoria.ts");
    expect(await readdir(cwd)).toHaveLength(10);
  });

  it("pins the @graphoria/server of its own version", () => {
    expect(wrapper.version).toBe(server.version);
    expect(wrapper.dependencies["@graphoria/server"]).toBe(server.version);
  });
});

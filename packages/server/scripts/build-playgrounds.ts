#!/usr/bin/env bun
import { Glob } from "bun";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const PLAYGROUNDS_DIR = resolve(REPO_ROOT, "packages/playgrounds");

const PLAYGROUNDS = ["graphiql", "scalar", "console"];

const SHARED_PATTERNS = ["public/**/*", "package.json", "vite.config.ts", "tsconfig.json"];

async function newestMtime(patterns: string[]): Promise<number> {
  let max = 0;
  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for await (const rel of glob.scan({ cwd: PLAYGROUNDS_DIR, onlyFiles: true })) {
      const m = statSync(resolve(PLAYGROUNDS_DIR, rel)).mtimeMs;
      if (m > max) max = m;
    }
  }
  return max;
}

// Root lockfile stands in for the per-package one: a dep bump must trigger a rebuild.
const rootLock = resolve(REPO_ROOT, "bun.lock");
const lockMtime = existsSync(rootLock) ? statSync(rootLock).mtimeMs : 0;
const sharedMtime = Math.max(lockMtime, await newestMtime(SHARED_PATTERNS));

const stale: string[] = [];

for (const name of PLAYGROUNDS) {
  const output = resolve(REPO_ROOT, "packages/server/playgrounds", name, "index.html");

  if (!existsSync(output)) {
    stale.push(name);
    continue;
  }
  const srcMtime = Math.max(sharedMtime, await newestMtime([`${name}/**/*`]));
  const outMtime = statSync(output).mtimeMs;
  if (srcMtime > outMtime) stale.push(name);
}

if (stale.length === 0) {
  console.log("[playgrounds] up-to-date, skipping build");
  process.exit(0);
}

console.log(`[playgrounds] rebuilding: ${stale.join(", ")}`);

const scripts = stale.length === PLAYGROUNDS.length ? ["build"] : stale.map((n) => `build:${n}`);
for (const script of scripts) {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: PLAYGROUNDS_DIR,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

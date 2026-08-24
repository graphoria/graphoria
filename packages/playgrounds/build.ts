#!/usr/bin/env bun
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

import workerInline from "./worker-inline";

import type { BunPlugin } from "bun";

const APPS = ["graphiql", "scalar", "console"] as const;
type App = (typeof APPS)[number];

const PLUGINS: Record<App, BunPlugin[]> = {
  graphiql: [workerInline],
  scalar: [],
  console: [tailwind],
};

const requested = process.argv.slice(2);
for (const app of requested) {
  if (!APPS.includes(app as App)) {
    throw new Error(`Unknown playground "${app}" — use one of ${APPS.join(", ")}`);
  }
}

for (const app of requested.length > 0 ? (requested as App[]) : APPS) {
  const start = performance.now();
  const outdir = resolve(import.meta.dir, "../server/playgrounds", app);

  await Bun.build({
    entrypoints: [resolve(import.meta.dir, app, "index.html")],
    outdir,
    target: "browser",
    // Inlines every script, stylesheet and asset into the HTML itself.
    compile: true,
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: PLUGINS[app],
  });

  const { size } = await Bun.file(resolve(outdir, "index.html")).stat();
  console.log(
    `[playgrounds] ${app}: ${(size / 1024 / 1024).toFixed(2)} MB in ${Math.round(performance.now() - start)}ms`,
  );
}

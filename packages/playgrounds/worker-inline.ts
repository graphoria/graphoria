import { dirname } from "node:path";

import type { BunPlugin } from "bun";

// Bun's browser bundler leaves `new Worker(new URL(...))` untouched, and a
// single-file playground has no sibling chunk to point at anyway. Each worker is
// bundled on its own — in a subprocess, because a nested `Bun.build` inside a
// plugin hangs — and handed to the app as a blob URL.
const workerInline: BunPlugin = {
  name: "worker-inline",
  setup(build) {
    build.onResolve({ filter: /\?worker&inline$/ }, (args) => ({
      path: Bun.resolveSync(args.path.replace(/\?worker&inline$/, ""), dirname(args.importer)),
      namespace: "worker-inline",
    }));

    build.onLoad({ filter: /.*/, namespace: "worker-inline" }, async (args) => {
      const proc = Bun.spawn(
        ["bun", "build", args.path, "--target=browser", "--format=iife", "--production"],
        { stdout: "pipe", stderr: "inherit" },
      );
      const source = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) {
        throw new Error(`Failed to bundle worker ${args.path}`);
      }
      return {
        loader: "js",
        contents: `const url = URL.createObjectURL(
  new Blob([${JSON.stringify(source)}], { type: "text/javascript" }),
);
export default class extends Worker {
  constructor(options) {
    super(url, options);
  }
}`,
      };
    });
  },
};

export default workerInline;

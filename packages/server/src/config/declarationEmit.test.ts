import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A project that emits declarations for its `graphoria.ts` (`declaration` or
 * `composite`) has to name every type `operation()` returns, through the
 * package's `exports`. The repo's own type-check cannot see a miss: a relative
 * import can always name a type.
 */

const SERVER_ROOT = join(import.meta.dir, "..", "..");
const REPO_ROOT = join(SERVER_ROOT, "..", "..");

const CONSUMER = `import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ operation, z }) => {
  const listItems = operation({
    query: "query { items { id } }",
    input: z.object({ limit: z.number().default(10) }),
    rest: { path: "/items" },
  });

  return {
    name: "declaration-emit",
    version: "1.0.0",
    operations: {
      listItems,
      slowItems: { ...listItems, timeout: 5 },
    },
  };
}) satisfies ConfigurationFn;
`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-declaration-emit-"));

  // Source on purpose: the real package's `types` condition answers from
  // whatever `dist` the checkout holds.
  const server = join(dir, "node_modules", "@graphoria", "server");
  await mkdir(server, { recursive: true });
  await writeFile(
    join(server, "package.json"),
    JSON.stringify({
      name: "@graphoria/server",
      version: "0.0.0",
      type: "module",
      exports: { "./config": "./src/config/index.ts" },
    }),
  );
  await symlink(join(SERVER_ROOT, "src"), join(server, "src"));

  await writeFile(join(dir, "graphoria.ts"), CONSUMER);
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(REPO_ROOT, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "./out",
        types: ["bun"],
        typeRoots: [join(REPO_ROOT, "node_modules", "@types")],
      },
      files: ["graphoria.ts"],
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("declaration emit of a configuration", () => {
  it("names operation()'s types through @graphoria/server/config", async () => {
    const tsc = Bun.spawn([join(SERVER_ROOT, "node_modules", ".bin", "tsc"), "-p", dir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(tsc.stdout).text();

    expect({ exitCode: await tsc.exited, output }).toEqual({ exitCode: 0, output: "" });

    const declaration = await Bun.file(join(dir, "out", "graphoria.d.ts")).text();
    expect(declaration).toContain('import("@graphoria/server/config").OperationTypes<');
  }, 60_000);
});

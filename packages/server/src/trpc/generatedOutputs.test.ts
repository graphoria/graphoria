import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The generated GraphoriaGeneratedOperationOutputs reaching a client through
 * `import type config`, in the server project and in a client with its own
 * install of the package. Entries are declared only in these temp projects: one
 * under src/ would reach every type test in the package.
 */

const SERVER_ROOT = join(import.meta.dir, "..", "..");
const REPO_ROOT = join(SERVER_ROOT, "..", "..");
// Run under Bun, as initTemplates.test.ts runs it: node_modules/.bin/tsc needs node.
const TSC = Bun.resolveSync("typescript/bin/tsc", import.meta.dir);

const CONFIG = `import type {} from "./graphoria-env";
import type { ConfigurationFn } from "@graphoria/server/config";

export default (({ operation, z }) => ({
  name: "generated-outputs",
  version: "1.0.0",
  operations: {
    books: operation({ query: "query { main_books { id title } }", rest: { path: "/books" } }),
    addBook: operation({ query: "mutation { main_add_book }", rest: { path: "/add-book", method: "POST" } }),
    ping: operation({ query: "query { ping }", rest: { path: "/ping" } }),
    typed: operation({ query: "query { main_books { id } }", output: z.object({ count: z.number() }), rest: { path: "/typed" } }),
    loose: operation({ query: "query { main_books { id } }", output: z.any(), rest: { path: "/loose" } }),
  },
})) satisfies ConfigurationFn;
`;

const GENERATED = `declare global {
  interface GraphoriaGeneratedOperationOutputs {
    books: { main_books: { id: number; title: string }[] };
    addBook: { main_add_book: boolean };
    typed: { stale: true };
  }
}
export {};
`;

const client = (
  configImport: string,
) => `import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { TRPCRouterOf } from "@graphoria/server/trpc";
import type config from "${configImport}";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const client = createTRPCClient<TRPCRouterOf<typeof config>>({
  links: [httpBatchLink({ url: "http://localhost/trpc" })],
});

export const checks = async () => {
  const books = await client.books.query();
  const booksTyped: Equal<typeof books, { main_books: { id: number; title: string }[] }> = true;
  const added = await client.addBook.mutate();
  const addedTyped: Equal<typeof added, { main_add_book: boolean }> = true;
  const pong = await client.ping.query();
  const pongTyped: Equal<typeof pong, unknown> = true;
  const typed = await client.typed.query();
  const typedTyped: Equal<typeof typed, { count: number }> = true;
  // An \`any\` output stays \`any\`: \`unknown extends any\` holds too.
  const loose = await client.loose.query();
  const looseTyped: Equal<typeof loose, any> = true;
  // @ts-expect-error the generated type has no such field
  void books.main_books[0]?.nope;
  return [booksTyped, addedTyped, pongTyped, typedTyped, looseTyped];
};
`;

let dir: string;

const tsconfig = () =>
  JSON.stringify({
    extends: join(REPO_ROOT, "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      types: ["bun"],
      typeRoots: [join(REPO_ROOT, "node_modules", "@types")],
    },
    files: ["client.ts"],
  });

const packageJson = JSON.stringify({
  name: "@graphoria/server",
  version: "0.0.0",
  type: "module",
  exports: { "./config": "./src/config/index.ts", "./trpc": "./src/trpc/index.ts" },
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-generated-outputs-"));

  // The server's dependencies, for both projects and the copied package.
  await mkdir(join(dir, "node_modules"));
  for (const name of await readdir(join(SERVER_ROOT, "node_modules"))) {
    if (name === "@graphoria" || name === ".bin") continue;
    await symlink(join(SERVER_ROOT, "node_modules", name), join(dir, "node_modules", name));
  }

  // The server project: the package's source, linked.
  const linked = join(dir, "server", "node_modules", "@graphoria", "server");
  await mkdir(linked, { recursive: true });
  await writeFile(join(linked, "package.json"), packageJson);
  await symlink(join(SERVER_ROOT, "src"), join(linked, "src"));
  await writeFile(join(dir, "server", "graphoria.ts"), CONFIG);
  await writeFile(join(dir, "server", "graphoria-env.d.ts"), GENERATED);
  await writeFile(join(dir, "server", "client.ts"), client("./graphoria"));
  await writeFile(join(dir, "server", "tsconfig.json"), tsconfig());

  // A client with its own install: a copy, which TypeScript sees as a second package.
  const copied = join(dir, "client", "node_modules", "@graphoria", "server");
  await mkdir(copied, { recursive: true });
  await writeFile(join(copied, "package.json"), packageJson);
  await cp(join(SERVER_ROOT, "src"), join(copied, "src"), { recursive: true });
  await writeFile(join(dir, "client", "client.ts"), client("../server/graphoria"));
  await writeFile(join(dir, "client", "tsconfig.json"), tsconfig());
});

afterAll(() => rm(dir, { recursive: true, force: true }));

const typeCheck = async (project: string) => {
  const tsc = Bun.spawn([process.execPath, TSC, "-p", join(dir, project)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(tsc.stdout).text();
  return { exitCode: await tsc.exited, output };
};

describe("GraphoriaGeneratedOperationOutputs", () => {
  it("types a plain-string query and mutation from the generated file, in the server project", async () => {
    expect(await typeCheck("server")).toEqual({ exitCode: 0, output: "" });
  }, 60_000);

  it("types them in a client with its own install of the package", async () => {
    expect(await typeCheck("client")).toEqual({ exitCode: 0, output: "" });
  }, 60_000);
});

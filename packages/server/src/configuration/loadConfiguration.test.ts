import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-load-config-"));
});

afterAll(() => rm(dir, { recursive: true, force: true }));

const failureOf = async (path: string) => {
  const { loadConfiguration } = await import(".");
  return loadConfiguration(path).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
};

describe("loadConfiguration", () => {
  it("names the file it looked for when there is none", async () => {
    const path = join(dir, "missing.ts");

    expect((await failureOf(path))?.message).toBe(
      `Configuration could not be loaded: no file at ${path}`,
    );
  });

  it("keeps what a config that throws said, in its message and as its cause", async () => {
    const path = join(dir, "throws.ts");
    await writeFile(path, 'export default () => { throw new Error("BOOKS_URL is not set"); };\n');

    const error = await failureOf(path);

    expect(error?.message).toBe("Configuration could not be loaded: BOOKS_URL is not set");
    expect(error?.cause).toHaveProperty("message", "BOOKS_URL is not set");
  });

  it("names a module the config imports that does not resolve", async () => {
    const path = join(dir, "imports.ts");
    await writeFile(path, 'import books from "./books";\nexport default () => books;\n');

    expect((await failureOf(path))?.message).toStartWith(
      "Configuration could not be loaded: Cannot find module './books'",
    );
  });
});

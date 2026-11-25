import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.LOG_LEVEL ??= "silent";

type Source = Parameters<typeof import(".").loadConfiguration>[0];

const INVALID =
  "Configuration could not be loaded: Invalid configuration: expected the configuration function or a plain object";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "graphoria-load-config-"));
});

afterAll(() => rm(dir, { recursive: true, force: true }));

const load = async (source: Source) => {
  const { loadConfiguration } = await import(".");
  return loadConfiguration(source);
};

const failureOf = (source: Source) =>
  load(source).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

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

  it("names the file when it has no default export", async () => {
    const path = join(dir, "named.ts");
    await writeFile(path, 'export const config = () => ({ name: "named", version: "1.0.0" });\n');

    expect((await failureOf(path))?.message).toBe(
      `Configuration could not be loaded: no default export in ${path}`,
    );
  });

  it("calls a configuration function once, with the helpers, and returns what it returns", async () => {
    const config = await import("../config");
    const configuration = { name: "inline", version: "1.0.0" };
    const calls: unknown[] = [];

    const loaded = await load((helpers) => {
      calls.push(helpers);
      return configuration;
    });

    expect(loaded).toBe(configuration);
    expect(calls).toEqual([
      {
        z: config.z,
        operation: config.operation,
        createOneToBooleanMSSQL: config.createOneToBooleanMSSQL,
        createYAndNToBooleanMSSQL: config.createYAndNToBooleanMSSQL,
        virtualColumnExpression: config.virtualColumnExpression,
        virtualColumnFunction: config.virtualColumnFunction,
      },
    ]);
  });

  it("awaits a configuration function that returns a promise", async () => {
    const configuration = { name: "async", version: "1.0.0" };

    // ConfigurationFn is typed synchronous, for TRPCRouterOf; the boot awaits anyway.
    expect(await load((async () => configuration) as never)).toBe(configuration);
  });

  it("returns a configuration object as it is", async () => {
    const configuration = { name: "object", version: "1.0.0" };

    expect(await load(configuration)).toBe(configuration);
  });

  it.each([
    { what: "a number", value: 7 },
    { what: "an array", value: [] },
    { what: "a class instance", value: new (class Configuration {})() },
  ])("rejects $what", async ({ value }) => {
    expect((await failureOf(value as never))?.message).toBe(INVALID);
  });

  it("rejects a module namespace, naming its default export", async () => {
    const path = join(dir, "namespace.ts");
    await writeFile(path, 'export default () => ({ name: "namespace", version: "1.0.0" });\n');

    expect((await failureOf(await import(path)))?.message).toBe(
      `${INVALID}; pass the module's default export`,
    );
  });

  it("keeps what a configuration function that throws said, passed inline", async () => {
    const error = await failureOf(() => {
      throw new Error("BOOKS_URL is not set");
    });

    expect(error?.message).toBe("Configuration could not be loaded: BOOKS_URL is not set");
    expect(error?.cause).toHaveProperty("message", "BOOKS_URL is not set");
  });

  it("keeps what an async configuration function that rejects said, in a file or inline", async () => {
    const path = join(dir, "rejects.ts");
    await writeFile(
      path,
      'export default async () => { throw new Error("BOOKS_URL is not set"); };\n',
    );
    const rejects = async () => {
      throw new Error("BOOKS_URL is not set");
    };

    for (const source of [path, rejects as never]) {
      const error = await failureOf(source);

      expect(error?.message).toBe("Configuration could not be loaded: BOOKS_URL is not set");
      expect(error?.cause).toHaveProperty("message", "BOOKS_URL is not set");
    }
  });
});

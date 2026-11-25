import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load; the parity test boots in-process.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

const CLI = join(import.meta.dir, "..", "..", "cli.ts");

let root: string;
let seq = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "graphoria-codegen-"));
});

afterAll(() => rm(root, { recursive: true, force: true }));

type ConfigOptions = { roles?: string[]; extra?: string; filename?: string };

const configSource = (dir: string, { roles = ["reader"], extra = "", filename }: ConfigOptions) =>
  `export default ({ operation }) => ({
  name: "codegen-test",
  version: "1.0.0",
  databases: [{ name: "main", type: "sqlite", enabled: true, connection: { filename: ${JSON.stringify(filename ?? join(dir, "app.db"))} } }],
  auth: {
    enabled: true,
    database: "main",
    schema: "main",
    autoCreateTables: true,
    permissions: {
      anonymous: { tables: ["main_books"], operations: ["books"] },
      ${roles.map((role) => `${role}: { tables: ["main_books"] },`).join("\n      ")}
    },
  },
  operations: {
    books: operation({
      query: "query { main_books(orderBy: [{ id: ASC }]) { id title published_year } }",
      rest: { path: "/books", method: "GET" },
      cache: { ttl: 1000 },
    }),
  },
  ${extra}
});
`;

const project = async (options: ConfigOptions = {}) => {
  const dir = join(root, `p${seq++}`);
  await mkdir(dir, { recursive: true });
  const db = new Database(join(dir, "app.db"), { create: true });
  db.run(
    "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, published_year INTEGER NOT NULL);" +
      "INSERT INTO books VALUES (1, 'Dune', 1965);",
  );
  db.close();
  await writeFile(join(dir, "graphoria.ts"), configSource(dir, options));
  return dir;
};

// No ADMIN_SECRET and no .env: the command needs neither.
const codegen = (dir: string, args: string[] = [], env: Record<string, string> = {}) => {
  const started = performance.now();
  const result = Bun.spawnSync(["bun", CLI, "codegen", ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    output: result.stdout.toString() + result.stderr.toString(),
    ms: performance.now() - started,
  };
};

const ls = async (dir: string) => (await readdir(dir).catch(() => [])).sort();
const ROLES = ["anonymous", "reader", "superadmin"];

describe("graphoria codegen", () => {
  it("writes one schema and one OpenAPI document per role, with no ADMIN_SECRET and no .env", async () => {
    const dir = await project();

    const result = codegen(dir);

    expect(result.exitCode).toBe(0);
    expect(await ls(join(dir, ".graphoria", "schemas"))).toEqual(
      ROLES.map((role) => `schema_${role}.graphql`),
    );
    expect(await ls(join(dir, ".graphoria", "openapi"))).toEqual(
      ROLES.map((role) => `openapi_${role}.json`),
    );
    expect(result.stdout).toContain("  ✓ GraphQL schemas     .graphoria/schemas/\n");
  }, 30_000);

  it("logs no debug or info line unless LOG_LEVEL asks", async () => {
    const dir = await project();

    const quiet = codegen(dir);
    const loud = codegen(dir, [], { LOG_LEVEL: "debug" });

    expect(
      quiet.stdout
        .split("\n")
        .filter(Boolean)
        .every((line) => /^(graphoria codegen {2}| {2}[✓–] | {2}Done in )/.test(line)),
    ).toBe(true);
    // An info line: SQLite's introspection reads bun:sqlite directly, so the
    // executor's debug `query executed` never prints here.
    expect(loud.stdout).toContain("configuration analysis complete");
  }, 30_000);

  it("prints the roles, a line per output relative to the working directory, and the time", async () => {
    const { summaryLines } = await import("./codegen");

    expect(
      summaryLines(
        {
          roles: ["superadmin", "anonymous", "reader", "editor"],
          schemasDir: "/p/.graphoria/schemas",
          openapiDir: "/p/out/openapi",
          types: { path: "/p/graphoria-env.d.ts", operations: 0 },
        },
        "/p",
        412,
      ),
    ).toEqual([
      "graphoria codegen  4 roles: superadmin, anonymous, reader, editor",
      "",
      "  ✓ GraphQL schemas     .graphoria/schemas/",
      "  ✓ OpenAPI documents   out/openapi/",
      "  ✓ tRPC output types   graphoria-env.d.ts (0 operations)",
      "",
      "  Done in 412ms",
    ]);
  });

  it("colors the summary through a pipe under FORCE_COLOR", async () => {
    const dir = await project();

    const result = codegen(dir, [], { FORCE_COLOR: "1" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("\x1b[36m\x1b[1mgraphoria codegen\x1b[22m\x1b[39m");
    expect(result.stdout).toContain(
      "  \x1b[32m✓\x1b[39m GraphQL schemas     \x1b[36m.graphoria/schemas/\x1b[39m\n",
    );
  }, 30_000);

  it("creates no auth table, though autoCreateTables is on", async () => {
    const dir = await project();

    expect(codegen(dir).exitCode).toBe(0);

    const db = new Database(join(dir, "app.db"), { readonly: true });
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'user'").all()).toEqual([]);
    } finally {
      db.close();
    }
  }, 30_000);

  it("writes what a PRINT_SCHEMAS boot writes, and the analysis's documents, cache or not", async () => {
    const dir = await project();
    expect(codegen(dir).exitCode).toBe(0);

    const bootDir = join(dir, "boot-schemas");
    const { createHandlers } = await import("../index");
    const { env } = await import("../singletons/env");
    const { disconnectDatabases } = await import("../singletons/databases");
    const handlers = await createHandlers({
      dbConnectRetryMs: 0,
      queryTimeoutMs: 0,
      authStore: "memory",
      rateLimit: { ...env.rateLimit, store: "memory" },
      // Another file may have loaded the env singleton without JWT_SECRET; auth needs one.
      jwt: { ...env.jwt, secrets: ["test-jwt-secret"] },
      configuration: join(dir, "graphoria.ts"),
      schemas: { print: true, outputDir: bootDir },
    });
    try {
      for (const name of await ls(bootDir)) {
        expect(await Bun.file(join(dir, ".graphoria", "schemas", name)).text()).toBe(
          await Bun.file(join(bootDir, name)).text(),
        );
      }
      expect(await ls(join(dir, ".graphoria", "schemas"))).toEqual(await ls(bootDir));

      // Called, not fetched: under the happy-dom preload the route's S200 is
      // happy-dom's Response, which Bun.serve refuses.
      const openapiRoute = handlers.serverHandlers.routes[
        handlers.prefixes.openapi
      ] as () => Response;
      const served = await openapiRoute().json();
      expect(
        await Bun.file(join(dir, ".graphoria", "openapi", "openapi_superadmin.json")).json(),
      ).toEqual(served);
    } finally {
      await disconnectDatabases();
    }

    // Every role's document, against the analysis the boot runs, `cache` kept.
    const { analyzeConfiguration, loadConfiguration } = await import("../configuration");
    const { instantiateDatabasesConnections } = await import("../singletons/databases");
    const { ConfigurationZod } = await import("../types/zod/configuration");
    const configuration = ConfigurationZod.parse(
      await loadConfiguration(join(dir, "graphoria.ts")),
    );
    await instantiateDatabasesConnections(configuration.enabledDatabases, 0);
    try {
      const analyzed = await analyzeConfiguration(configuration, env);
      for (const role of ROLES) {
        expect(
          await Bun.file(join(dir, ".graphoria", "openapi", `openapi_${role}.json`)).json(),
        ).toEqual(JSON.parse(JSON.stringify(analyzed.openapiFor(role))));
      }
    } finally {
      await disconnectDatabases();
    }
  }, 60_000);

  it("exits 0 at once with a Redis store and a broker on closed ports", async () => {
    const dir = await project({
      extra: `caches: { default: ["redis"], stores: { redis: { type: "redis", url: "redis://127.0.0.1:1" } } },
  queues: [{
    type: "rabbitmq", name: "events", enabled: true,
    connection: { hostname: "127.0.0.1", port: 1, username: "u", password: "p", vhost: "/" },
    publishers: { bookAdded: { topic: "books", routingKey: "book.added" } },
    topics: { books: { type: "topic" } },
  }],`,
    });

    const result = codegen(dir);

    expect(result.exitCode).toBe(0);
    expect(result.ms).toBeLessThan(10_000);
  }, 30_000);

  it.each([
    [
      "SUPERADMIN_ROLE equal to ANONYMOUS_ROLE",
      {},
      { SUPERADMIN_ROLE: "anonymous" },
      "SUPERADMIN_ROLE and ANONYMOUS_ROLE are both",
    ],
    [
      "a remote schema at a closed port",
      { extra: 'remoteSchemas: [{ name: "ext", url: "http://127.0.0.1:1/graphql" }],' },
      {},
      'remote schema "ext"',
    ],
    [
      "a database it cannot open",
      { filename: "/nonexistent-dir/app.db" },
      {},
      '  ✗ Could not connect to database "main" at /nonexistent-dir/app.db: unable to open database file\n',
    ],
  ])(
    "exits 1 with nothing written on %s",
    async (_case, options, env, message) => {
      const dir = await project(options as ConfigOptions);

      const result = codegen(dir, [], env as Record<string, string>);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(message);
      expect(await ls(join(dir, ".graphoria"))).toEqual([]);
    },
    30_000,
  );

  it("prints a line per retry while a database does not answer, then names it", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "graphoria.ts"),
      `export default () => ({ name: "x", version: "1.0.0", databases: [{ name: "main", type: "pg", enabled: true,
  connection: { host: "127.0.0.1", port: 1, user: "u", password: "p", database: "d" } }] });\n`,
    );

    const result = codegen(dir, [], { DB_CONNECT_RETRY_MS: "1500" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.split("\n");
    const header = lines.indexOf("graphoria codegen  failed");
    expect(header).toBeGreaterThan(0);
    for (const line of lines.slice(0, header)) {
      expect(line).toMatch(
        /^Waiting for database "main" at 127\.0\.0\.1:1: Failed to connect, retrying in \S+$/,
      );
    }
    expect(lines.slice(header)).toEqual([
      "graphoria codegen  failed",
      "",
      '  ✗ Could not connect to database "main" at 127.0.0.1:1: Failed to connect',
      "",
    ]);
  }, 30_000);

  it.each([
    [
      "fails to load",
      'export default () => { throw new Error("BOOKS_URL is not set (see .env)"); };\n',
      ["  ✗ Configuration could not be loaded: BOOKS_URL is not set (see .env)"],
    ],
    [
      "fails to validate",
      "export default () => ({ name: 1 });\n",
      [
        "  ✗ graphoria.ts is invalid",
        "    name     Invalid input: expected string, received number",
        "    version  Invalid input: expected string, received undefined",
      ],
    ],
  ])(
    "exits 1 with nothing written on a config that %s, saying why on stderr alone",
    async (_case, source, lines) => {
      const dir = await project();
      await writeFile(join(dir, "graphoria.ts"), source);

      const result = codegen(dir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(["graphoria codegen  failed", "", ...lines, ""].join("\n"));
      expect(await ls(join(dir, ".graphoria"))).toEqual([]);
    },
    30_000,
  );

  it("names the file it looked for when the config is missing", async () => {
    const dir = await project();

    const result = codegen(dir, ["--config", "./missing.ts"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `  ✗ Configuration could not be loaded: no file at ${join(await realpath(dir), "missing.ts")}\n`,
    );
  }, 30_000);

  it("prints the stack too under LOG_LEVEL=debug", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "graphoria.ts"),
      'export default () => { throw new Error("BOOKS_URL is not set"); };\n',
    );

    const quiet = codegen(dir);
    const loud = codegen(dir, [], { LOG_LEVEL: "debug" });

    expect(quiet.stderr).not.toContain("graphoria.ts:1:");
    expect(loud.stderr).toContain("graphoria.ts:1:");
  }, 30_000);

  it("prints the usage and exits 2 on an unknown flag", async () => {
    const dir = await project();

    const result = codegen(dir, ["--nope"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "codegen: Unknown option '--nope'\nUsage: graphoria codegen [--config <path>] [--out <dir>] [--types <file>]\n",
    );
  }, 30_000);

  it("deletes the files of a role no longer configured", async () => {
    const dir = await project({ roles: ["reader", "editor"] });
    expect(codegen(dir).exitCode).toBe(0);
    await writeFile(join(dir, "graphoria.ts"), configSource(dir, { roles: ["reader"] }));

    expect(codegen(dir).exitCode).toBe(0);

    expect(await ls(join(dir, ".graphoria", "schemas"))).not.toContain("schema_editor.graphql");
    expect(await ls(join(dir, ".graphoria", "openapi"))).not.toContain("openapi_editor.json");
  }, 30_000);

  it("writes under OUTPUT_DIR, and under --out over it", async () => {
    const dir = await project();

    expect(codegen(dir, [], { OUTPUT_DIR: "gen" }).exitCode).toBe(0);
    expect(await ls(join(dir, "gen"))).toEqual(["openapi", "schemas"]);

    expect(codegen(dir, ["--out", "other"], { OUTPUT_DIR: "unused" }).exitCode).toBe(0);
    expect(await ls(join(dir, "other"))).toEqual(["openapi", "schemas"]);
    expect(await ls(join(dir, "unused"))).toEqual([]);
  }, 30_000);

  it("warns once that it ignores SCHEMAS_OUTPUT_DIR, and writes under OUTPUT_DIR", async () => {
    const dir = await project();

    const result = codegen(dir, [], { SCHEMAS_OUTPUT_DIR: "legacy" });

    expect(result.exitCode).toBe(0);
    expect(
      result.output.split("SCHEMAS_OUTPUT_DIR is deprecated and codegen ignores it"),
    ).toHaveLength(2);
    expect(await ls(join(dir, "legacy"))).toEqual([]);
    expect(await ls(join(dir, ".graphoria"))).toEqual(["openapi", "schemas"]);
  }, 30_000);

  it("writes the types file beside the config, typing its plain-string operations", async () => {
    const dir = await project();
    await mkdir(join(dir, "server"));
    await writeFile(join(dir, "server", "graphoria.ts"), configSource(dir, {}));

    const result = codegen(dir, ["--config", "server/graphoria.ts"]);

    expect(result.exitCode).toBe(0);
    const types = await Bun.file(join(dir, "server", "graphoria-env.d.ts")).text();
    expect(types).toContain("interface GraphoriaGeneratedOperationOutputs");
    expect(types).toMatch(
      /books: \{\s*main_books: \{ id: number; title: string; published_year: number \}\[\];?\s*\}/,
    );
    expect(result.stdout).toContain(
      "  ✓ tRPC output types   server/graphoria-env.d.ts (1 operation)\n",
    );
  }, 30_000);

  it("skips the types file, saying so, when @trpc/server does not resolve", async () => {
    const dir = await project();
    const { runCodegen } = await import("./codegen");

    const result = await runCodegen(
      { config: join(dir, "graphoria.ts"), out: join(dir, ".graphoria") },
      { trpcResolves: () => false },
    );

    expect(result.types.operations).toBeUndefined();
    expect(await Bun.file(join(dir, "graphoria-env.d.ts")).exists()).toBe(false);
  }, 30_000);

  it("prints how many operations the types file holds, or that it skipped it", async () => {
    const { summaryLines } = await import("./codegen");
    const typesLine = (operations?: number) =>
      summaryLines(
        {
          roles: ["reader"],
          schemasDir: "/p/s",
          openapiDir: "/p/o",
          types: { path: "/p/graphoria-env.d.ts", operations },
        },
        "/p",
        4210,
      );

    expect(typesLine(1)[0]).toBe("graphoria codegen  1 role: reader");
    expect(typesLine(1)[4]).toBe("  ✓ tRPC output types   graphoria-env.d.ts (1 operation)");
    expect(typesLine(2)[4]).toBe("  ✓ tRPC output types   graphoria-env.d.ts (2 operations)");
    expect(typesLine()[4]).toBe("  – tRPC output types   skipped: @trpc/server is not installed");
    expect(typesLine(1)[6]).toBe("  Done in 4.2s");
  });
});

describe("failureLines", () => {
  it("prints the error under a failed header", async () => {
    const { failureLines } = await import("./codegen");

    expect(failureLines(new Error("boom"))).toEqual(["graphoria codegen  failed", "", "  ✗ boom"]);
  });

  it("indents a message's next lines under its first", async () => {
    const { failureLines } = await import("./codegen");

    expect(
      failureLines(
        new Error(
          'Configuration references 1 name that do not exist:\n  - a.b — no table named "b"',
        ),
      ),
    ).toEqual([
      "graphoria codegen  failed",
      "",
      "  ✗ Configuration references 1 name that do not exist:",
      '      - a.b — no table named "b"',
    ]);
  });

  it("prints a zod cause's issues a row apiece, their paths aligned", async () => {
    const { failureLines } = await import("./codegen");
    const { z } = await import("zod");
    const parsed = z
      .strictObject({ name: z.string(), databases: z.array(z.object({ type: z.string() })) })
      .safeParse({ name: 1, databases: [{}], extra: true });

    expect(failureLines(new Error("graphoria.ts is invalid", { cause: parsed.error }))).toEqual([
      "graphoria codegen  failed",
      "",
      "  ✗ graphoria.ts is invalid",
      "    name               Invalid input: expected string, received number",
      "    databases[0].type  Invalid input: expected string, received undefined",
      '    Unrecognized key: "extra"',
    ]);
  });

  it("paints the verdict and the mark in the failure color", async () => {
    const { failureLines } = await import("./codegen");
    const { COLOR_PAINT } = await import("./paint");

    const lines = failureLines(new Error("boom"), COLOR_PAINT);

    expect(lines.map((line) => Bun.stripANSI(line))).toEqual([
      "graphoria codegen  failed",
      "",
      "  ✗ boom",
    ]);
    expect(lines[0]).toEndWith("  \x1b[31mfailed\x1b[39m");
    expect(lines[2]).toBe("  \x1b[31m✗\x1b[39m boom");
  });
});

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
    expect(result.stdout).toContain("wrote .graphoria/schemas/schema_reader.graphql");
  }, 30_000);

  it("logs no debug or info line unless LOG_LEVEL asks", async () => {
    const dir = await project();

    const quiet = codegen(dir);
    const loud = codegen(dir, [], { LOG_LEVEL: "debug" });

    expect(
      quiet.stdout
        .split("\n")
        .filter(Boolean)
        .every((line) => line.startsWith("wrote ") || line.startsWith("typed ")),
    ).toBe(true);
    // An info line: SQLite's introspection reads bun:sqlite directly, so the
    // executor's debug `query executed` never prints here.
    expect(loud.stdout).toContain("configuration analysis complete");
  }, 30_000);

  it("prints a wrote line per file, relative to the working directory", async () => {
    const { summaryLines } = await import("./codegen");

    expect(
      summaryLines(
        {
          written: ["/p/.graphoria/schemas/schema_a.graphql", "/p/out/openapi_a.json"],
          types: { path: "/p/graphoria-env.d.ts", operations: 0 },
        },
        "/p",
      ),
    ).toEqual([
      "wrote .graphoria/schemas/schema_a.graphql",
      "wrote out/openapi_a.json",
      "typed 0 operations in graphoria-env.d.ts",
    ]);
  });

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
    ["a database it cannot open", { filename: "/nonexistent-dir/app.db" }, {}, "codegen failed"],
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

  it.each([
    [
      "fails to load",
      'export default () => { throw new Error("BOOKS_URL is not set (see .env)"); };\n',
    ],
    ["fails to validate", "export default () => ({ name: 1 });\n"],
  ])(
    "exits 1 with nothing written on a config that %s",
    async (_case, source) => {
      const dir = await project();
      await writeFile(join(dir, "graphoria.ts"), source);

      const result = codegen(dir);

      expect(result.exitCode).toBe(1);
      expect(await ls(join(dir, ".graphoria"))).toEqual([]);
    },
    30_000,
  );

  it("prints the usage and exits 2 on an unknown flag", async () => {
    const dir = await project();

    const result = codegen(dir, ["--nope"]);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Usage: graphoria codegen");
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
    expect(result.stdout).toContain("typed 1 operation in server/graphoria-env.d.ts");
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
    const types = (operations?: number) => ({ path: "/p/graphoria-env.d.ts", operations });

    expect(summaryLines({ written: [], types: types(1) }, "/p")).toEqual([
      "typed 1 operation in graphoria-env.d.ts",
    ]);
    expect(summaryLines({ written: [], types: types(2) }, "/p")).toEqual([
      "typed 2 operations in graphoria-env.d.ts",
    ]);
    expect(summaryLines({ written: [], types: types() }, "/p")).toEqual([
      "skipped graphoria-env.d.ts: @trpc/server does not resolve, and only @graphoria/server/trpc reads it",
    ]);
  });
});

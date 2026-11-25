import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `singletons/env` parses process.env at module load; JWT_SECRET too, since the
// first file to load it fixes env.jwt for every later file.
process.env.ADMIN_SECRET ??= "test-admin-secret";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.LOG_LEVEL ??= "silent";

/** PRINT_SCHEMAS and the deprecated SCHEMAS_OUTPUT_DIR, through the boot that reads them. */

let dir: string;

// What a boot starts, which an earlier file's boot may have left behind.
const stopStarted = async () => {
  const { setCronJobs } = await import("./singletons/cron");
  const { setQueueManager } = await import("./singletons/queues");

  setCronJobs(null);
  setQueueManager(undefined);
};

beforeEach(async () => {
  await stopStarted();
  dir = await mkdtemp(join(tmpdir(), "graphoria-print-schemas-"));
  new SQLiteDatabase(join(dir, "app.db"), { create: true }).close();
});

afterEach(async () => {
  const { disconnectDatabases } = await import("./singletons/databases");

  await disconnectDatabases();
  await stopStarted();
  await rm(dir, { recursive: true, force: true });
});

const boot = async (options: Record<string, unknown>) => {
  const { createHandlers } = await import("./index");
  const { env } = await import("./singletons/env");

  return createHandlers({
    dbConnectRetryMs: 0,
    queryTimeoutMs: 0,
    authStore: "memory",
    rateLimit: { ...env.rateLimit, store: "memory" },
    configuration: {
      name: "print-schemas-test",
      version: "1.0.0",
      databases: [
        {
          name: "default",
          enabled: true,
          type: "sqlite",
          connection: { filename: join(dir, "app.db") },
        },
      ],
    },
    ...options,
  });
};

const warningsAbout = async (options: Record<string, unknown>) => {
  const { logger } = await import("./logging");
  const warn = spyOn(logger("graphoria"), "warn").mockImplementation((() => {}) as never);
  try {
    await boot(options);
    return warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("SCHEMAS_OUTPUT_DIR"));
  } finally {
    warn.mockRestore();
  }
};

describe("PRINT_SCHEMAS", () => {
  it("writes every role's schema to the schemas.outputDir an embedder passes", async () => {
    const outputDir = join(dir, "embedder", "schemas");

    await boot({ schemas: { print: true, outputDir } });

    expect((await readdir(outputDir)).sort()).toEqual([
      "schema_anonymous.graphql",
      "schema_superadmin.graphql",
    ]);
  });
});

describe("SCHEMAS_OUTPUT_DIR at boot", () => {
  it("warns once that it is deprecated while PRINT_SCHEMAS still writes there", async () => {
    expect(await warningsAbout({ leftoverSchemasOutputDir: "read" })).toEqual([
      expect.stringContaining("set OUTPUT_DIR instead"),
    ]);
  });

  it("warns once that it is ignored once OUTPUT_DIR is set", async () => {
    expect(await warningsAbout({ leftoverSchemasOutputDir: "ignored" })).toEqual([
      expect.stringContaining("ignored"),
    ]);
  });

  it("stays quiet when it is not set", async () => {
    expect(await warningsAbout({ leftoverSchemasOutputDir: undefined })).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSeedAuthArgs } from "./seedAuthArgs";

// `singletons/env` parses process.env at module load, and seedAuth reaches it:
// seedAuth is imported only once the variable it requires is set.
process.env.ADMIN_SECRET ??= "test-admin-secret";

describe("parseSeedAuthArgs", () => {
  it("parses the full long-form invocation", () => {
    const args = parseSeedAuthArgs([
      "--user",
      "alice",
      "--password",
      "secret",
      "--role",
      "admin",
      "--config",
      "./custom.ts",
      "--claims",
      '{"tenant":"acme"}',
    ]);

    expect(args).toEqual({
      user: "alice",
      password: "secret",
      role: "admin",
      config: "./custom.ts",
      claims: { tenant: "acme" },
    });
  });

  it("supports short flags", () => {
    const args = parseSeedAuthArgs([
      "-u",
      "alice",
      "-p",
      "secret",
      "-r",
      "admin",
      "-c",
      "./graphoria.ts",
    ]);

    expect(args.user).toBe("alice");
    expect(args.password).toBe("secret");
    expect(args.role).toBe("admin");
    expect(args.config).toBe("./graphoria.ts");
    expect(args.claims).toEqual({});
  });

  it("requires --user", () => {
    expect(() => parseSeedAuthArgs(["--password", "p", "--role", "r"])).toThrow(
      "--user is required",
    );
  });

  it("requires --password", () => {
    expect(() => parseSeedAuthArgs(["--user", "u", "--role", "r"])).toThrow(
      "--password is required",
    );
  });

  it("requires --role", () => {
    expect(() => parseSeedAuthArgs(["--user", "u", "--password", "p"])).toThrow(
      "--role is required",
    );
  });

  it("requires --config", () => {
    expect(() => parseSeedAuthArgs(["--user", "u", "--password", "p", "--role", "r"])).toThrow(
      "--config is required",
    );
  });

  it("rejects malformed --claims", () => {
    expect(() =>
      parseSeedAuthArgs([
        ...["--user", "u", "--password", "p", "--role", "r", "--config", "./graphoria.ts"],
        ...["--claims", "{not-json"],
      ]),
    ).toThrow(/Invalid --claims JSON/);
  });

  it("rejects --claims that isn't a JSON object", () => {
    expect(() =>
      parseSeedAuthArgs([
        ...["--user", "u", "--password", "p", "--role", "r", "--config", "./graphoria.ts"],
        ...["--claims", "[]"],
      ]),
    ).toThrow(/--claims must be a JSON object/);
  });
});

describe("runSeedAuth", () => {
  let dir: string;
  let runSeedAuth: typeof import("./seedAuth").runSeedAuth;
  let env: typeof import("../singletons/env").env;
  let databasesConnections: typeof import("../singletons/databases").databasesConnections;
  const opened: string[] = [];

  beforeAll(async () => {
    ({ runSeedAuth } = await import("./seedAuth"));
    ({ env } = await import("../singletons/env"));
    ({ databasesConnections } = await import("../singletons/databases"));
    dir = await mkdtemp(join(tmpdir(), "graphoria-seed-auth-"));
  });

  afterAll(async () => {
    for (const name of opened) {
      (databasesConnections[name] as Database | undefined)?.close();
      delete databasesConnections[name];
    }
    await rm(dir, { recursive: true, force: true });
  });

  let seq = 0;
  // A SQLite project under a database name no other test uses: the connection
  // singleton is keyed by it.
  const project = async (autoCreateTables: boolean, roles: string[] = []) => {
    const name = `seed_auth_${seq++}`;
    const file = join(dir, `${name}.db`);
    const config = join(dir, `${name}.ts`);
    await writeFile(
      config,
      `export default () => (${JSON.stringify({
        name: "seed-auth-test",
        version: "1.0.0",
        databases: [{ name, type: "sqlite", enabled: true, connection: { filename: file } }],
        auth: {
          enabled: true,
          database: name,
          schema: "main",
          autoCreateTables,
          permissions: {
            [env.anonymousRole]: { tables: [] },
            reader: {},
            ...Object.fromEntries(roles.map((role) => [role, {}])),
          },
        },
      })});\n`,
    );
    opened.push(name);
    return { config, file };
  };

  const seed = (config: string, role: string) =>
    runSeedAuth({ user: "ada", password: "Pa55word.x", role, config, claims: {} });

  it("creates the user table and stores the user, hashed, with autoCreateTables", async () => {
    const { config, file } = await project(true);

    await seed(config, "reader");

    const db = new Database(file, { readonly: true });
    try {
      const row = db.query('SELECT username, password, role FROM "user"').get() as {
        username: string;
        password: string;
        role: string;
      };
      expect(row.username).toBe("ada");
      expect(row.role).toBe("reader");
      expect(row.password).toStartWith("$argon2id$");
      expect(await Bun.password.verify("Pa55word.x", row.password)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects a role auth.permissions does not define, before opening the database", async () => {
    const { config, file } = await project(true);

    await expect(seed(config, "edtior")).rejects.toThrow(
      `--role "edtior" is not a role a user can hold (reader, ${env.superadmin.role})`,
    );
    expect(existsSync(file)).toBe(false);
  });

  it("names the superadmin role once, though auth.permissions defines it", async () => {
    const { config } = await project(true, [env.superadmin.role]);

    await expect(seed(config, "edtior")).rejects.toThrow(`(reader, ${env.superadmin.role})`);
  });

  it("rejects the anonymous role, though auth.permissions defines it", async () => {
    const { config, file } = await project(true);

    await expect(seed(config, env.anonymousRole)).rejects.toThrow("is not a role a user can hold");
    expect(existsSync(file)).toBe(false);
  });

  it("accepts the superadmin role", async () => {
    const { config, file } = await project(true);

    await seed(config, env.superadmin.role);

    const db = new Database(file, { readonly: true });
    try {
      expect(db.query('SELECT role FROM "user"').get()).toEqual({ role: env.superadmin.role });
    } finally {
      db.close();
    }
  });

  it("still needs the table without autoCreateTables", async () => {
    const { config } = await project(false);

    await expect(seed(config, "reader")).rejects.toThrow("no such table");
  });
});

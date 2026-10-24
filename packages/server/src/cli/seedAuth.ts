import type { SeedAuthArgs } from "./seedAuthArgs";

import { loadConfiguration } from "../configuration";
import { createAuthTables, insertAuthUser } from "../databases";
import { instantiateDatabasesConnections } from "../singletons/databases";
import { env } from "../singletons/env";
import { ConfigurationZod } from "../types/zod/configuration";
import { parseSeedAuthArgs } from "./seedAuthArgs";
import { logger } from "../logging";

export const runSeedAuth = async (args: SeedAuthArgs): Promise<void> => {
  const rawConfig = await loadConfiguration(args.config);
  const configuration = ConfigurationZod.parse(rawConfig);

  if (!configuration.auth?.enabled) {
    throw new Error("auth.enabled must be true in the configuration to seed an auth user");
  }

  // A signed-in user holds a role of auth.permissions or the superadmin role,
  // never the anonymous one: that is what a caller without a token reads as.
  const roles = [
    ...Object.keys(configuration.auth.permissions).filter(
      (role) => role !== env.anonymousRole && role !== env.superadmin.role,
    ),
    env.superadmin.role,
  ];
  if (!roles.includes(args.role)) {
    throw new Error(`--role "${args.role}" is not a role a user can hold (${roles.join(", ")})`);
  }

  await instantiateDatabasesConnections([configuration.auth.databaseEntity]);

  // As the server's boot does, so a user can be seeded before the first boot.
  if (configuration.auth.autoCreateTables) await createAuthTables(configuration.auth);

  await insertAuthUser(configuration.auth, {
    username: args.user,
    password: args.password,
    role: args.role,
    claims: args.claims,
  });
};

export const seedAuthCommand = async (argv: string[]): Promise<void> => {
  const log = logger("cli");
  let args: SeedAuthArgs;
  try {
    args = parseSeedAuthArgs(argv);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, `seed-auth: ${msg}`);
    console.error(
      "Usage: graphoria seed-auth --user <name> --password <pwd> --role <role> --config <path> [--claims <json>]",
    );
    process.exit(2);
  }

  try {
    await runSeedAuth(args);
    log.info({ user: args.user, role: args.role }, "seeded auth user");
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, `seed-auth failed: ${msg}`);
    process.exit(1);
  }
};

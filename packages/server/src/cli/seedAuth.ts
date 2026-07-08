import type { SeedAuthArgs } from "./seedAuthArgs";

import { loadConfiguration } from "../configuration";
import { insertAuthUser } from "../databases";
import { instantiateDatabasesConnections } from "../singletons/databases";
import { ConfigurationZod } from "../types/zod/configuration";
import { parseSeedAuthArgs } from "./seedAuthArgs";
import { logger } from "../logging";

export const runSeedAuth = async (args: SeedAuthArgs): Promise<void> => {
  const rawConfig = await loadConfiguration(args.config);
  const configuration = ConfigurationZod.parse(rawConfig);

  if (!configuration.auth?.enabled) {
    throw new Error("auth.enabled must be true in the configuration to seed an auth user");
  }

  await instantiateDatabasesConnections([configuration.auth.databaseEntity]);

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

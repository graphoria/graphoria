import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { customAlphabet } from "nanoid";

import type { DatabaseType } from "../config";
import type { InitArgs } from "./initArgs";
import type { InitAnswers } from "./initTemplates";

import { version } from "../../package.json";
import { DATABASE_TYPES, isDatabaseType, parseInitArgs } from "./initArgs";
import { ENGINES, PROJECT_FILES, renderProject } from "./initTemplates";

type Ask = (question: string, fallback: string) => string | null;
type Say = (line: string) => void;

// 16, not more: see the MySQL rule in passwordError.
const randomAlphanumeric = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  16,
);

export const generatePassword = (): string => {
  for (;;) {
    const password = randomAlphanumeric();
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)) return password;
  }
};

export const generateSecret = (): string => randomBytes(32).toString("base64url");

export const projectName = (dir: string): string =>
  basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 214) || "graphoria-app";

export const findConflicts = (dir: string, paths: readonly string[]): string[] =>
  paths.filter((path) => existsSync(join(dir, path)));

const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// `$` is expanded by both Bun's .env loader and Compose, `#` starts a comment,
// and a leading `-` reads as a flag to sqlcmd in the SQL Server healthcheck.
const PASSWORD = /^[A-Za-z0-9._~!@%^*+=:?-]+$/;

export const passwordError = (database: DatabaseType, password: string): string | undefined => {
  if (!PASSWORD.test(password)) {
    return "Use only letters, digits and . _ ~ ! @ % ^ * + = : ? -";
  }
  if (password.startsWith("-")) return "The password cannot start with -.";
  // Bun 1.4's MySQL client fails caching_sha2_password logins over plain TCP
  // with a password of 20 or more characters: "Access denied".
  if (database === "mysql" && password.length >= 20) {
    return "Bun's MySQL client cannot log in with a password of 20 or more characters.";
  }
  if (database === "mssql") {
    const kinds = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((kind) => kind.test(password));
    if (password.length < 8 || kinds.length < 3) {
      return "SQL Server needs 8 or more characters with three of: uppercase, lowercase, digits, symbols.";
    }
  }
  return undefined;
};

const portError = (answer: string) => {
  const port = Number(answer);
  return /^\d+$/.test(answer) && port >= 1 && port <= 65535
    ? undefined
    : "Use a port number from 1 to 65535.";
};

const question = (
  ask: Ask,
  say: Say,
  text: string,
  fallback: string,
  error: (answer: string) => string | undefined,
): string => {
  for (;;) {
    const answer = ask(text, fallback)?.trim();
    if (!answer) return fallback;
    const reason = error(answer);
    if (!reason) return answer;
    say(reason);
  }
};

export const collectAnswers = (args: InitArgs, ask: Ask, say: Say): InitAnswers => {
  const database =
    args.database ??
    (question(ask, say, `Database engine (${DATABASE_TYPES.join(", ")})`, "pg", (answer) =>
      isDatabaseType(answer) ? undefined : `Choose one of ${DATABASE_TYPES.join(", ")}.`,
    ) as DatabaseType);

  const dbName = question(ask, say, "Database name", "app", (answer) =>
    DB_NAME.test(answer)
      ? undefined
      : "Use lowercase letters, digits and _, not starting with a digit, up to 63 characters.",
  );

  const dbPassword = question(ask, say, "Database password", generatePassword(), (answer) =>
    passwordError(database, answer),
  );

  const dbPort = Number(
    question(ask, say, "Database port on this host", String(ENGINES[database].port), portError),
  );

  return { database, dbName, dbPassword, dbPort };
};

export const isPortFree = (port: number): boolean => {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

export const portWarning = (
  port: number,
  isFree: (port: number) => boolean = isPortFree,
): string | undefined => {
  if (isFree(port)) return undefined;
  let free = port + 1;
  while (free <= 65535 && !isFree(free)) free++;
  const suggestion = free <= 65535 ? ` such as ${free}` : "";
  return `Port ${port} is in use on this host, so Docker Compose cannot publish the database on it. Set DB_PORT in .env to a free port${suggestion} before \`docker compose up\`.`;
};

// The seed's tables under the default `{schema}_{name}` field naming; a MySQL
// schema is its database.
export const sampleQuery = ({ database, dbName }: InitAnswers): string => {
  const schema = { pg: "public", mysql: dbName, mssql: "dbo" }[database];
  return `{ ${schema}_authors { name ${schema}_books { title } } }`;
};

const nextSteps = (answers: InitAnswers, installed: boolean) =>
  [
    ...(installed ? [] : ["First run `bun install`: the Dockerfile needs its bun.lock.", ""]),
    "Run everything in Docker:",
    "  docker compose up -d --build",
    "  then open http://localhost:3000/graphiql",
    "",
    "Or run Graphoria on the host against the database container:",
    answers.database === "mssql"
      ? "  docker compose run --rm db-init"
      : "  docker compose up -d --wait db",
    "  bun run dev",
    "",
    "The admin secret is ADMIN_SECRET in .env; send it in the x-admin-secret header.",
    `Try: ${sampleQuery(answers)}`,
  ].join("\n");

const USAGE = "Usage: graphoria init [--yes] [--database pg|mysql|mssql] [--no-install]";

export const initCommand = async (argv: string[]): Promise<never> => {
  let args: InitArgs;
  try {
    args = parseInitArgs(argv);
  } catch (error) {
    console.error(`init: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    process.exit(2);
  }

  const dir = process.cwd();
  const conflicts = findConflicts(dir, [...PROJECT_FILES, "bun.lock"]);
  if (conflicts.length > 0) {
    console.error("init: these files already exist, so nothing was written:");
    for (const path of conflicts) console.error(`  ${path}`);
    process.exit(1);
  }

  const answers = collectAnswers(args, args.yes ? () => null : prompt, console.log);
  const warning = portWarning(answers.dbPort);
  if (warning) console.warn(warning);

  const name = projectName(dir);
  const files = renderProject(
    { ...answers, name, adminSecret: generateSecret(), jwtSecret: generateSecret() },
    { graphoria: version, bun: Bun.version },
  );

  const written: string[] = [];
  try {
    for (const [path, content] of Object.entries(files)) {
      await Bun.write(join(dir, path), content);
      written.push(path);
    }
  } catch (error) {
    console.error(`init: ${error instanceof Error ? error.message : String(error)}`);
    if (written.length > 0) console.error(`Written before the failure: ${written.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nCreated ${name} (${ENGINES[answers.database].label}): ${written.join(", ")}\n`);

  if (args.install) {
    const install = Bun.spawn(["bun", "install"], {
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    if ((await install.exited) !== 0) {
      console.error("init: bun install failed. The files are written; run `bun install` next.");
      process.exit(1);
    }
    console.log("");
  }

  console.log(nextSteps(answers, args.install));
  process.exit(0);
};

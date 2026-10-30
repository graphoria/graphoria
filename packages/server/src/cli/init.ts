import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { customAlphabet } from "nanoid";

import type { DatabaseType } from "../config";
import type { InitArgs } from "./initArgs";
import type { InitAnswers } from "./initTemplates";
import type { Ask, Choice, MultiSelect, Say, Select } from "./prompt";

import { version } from "../../package.json";
import { DATABASE_TYPES, dbNameError, parseInitArgs, portError } from "./initArgs";
import {
  DBGATE_PORT,
  ENGINES,
  FRONTEND_FILES,
  JAEGER_UI_PORT,
  PROJECT_FILES,
  RABBITMQ_MANAGEMENT_PORT,
  RABBITMQ_PORT,
  REDIS_COMMANDER_PORT,
  renderProject,
  seedSchema,
} from "./initTemplates";
import { ask, interactive, multiSelect, select } from "./prompt";

export type InitIO = {
  ask: Ask;
  say: Say;
  select: Select;
  multiSelect: MultiSelect;
};

const DATABASE_LABELS: Record<DatabaseType, string> = {
  pg: ENGINES.pg.label,
  mysql: ENGINES.mysql.label,
  mssql: ENGINES.mssql.label,
  sqlite: "SQLite",
};

type Extra =
  | "rabbitmq"
  | "ai"
  | "mcp"
  | "auth"
  | "redis"
  | "dataTools"
  | "frontend"
  | "cron"
  | "rateLimit"
  | "metrics"
  | "tracing"
  | "virtualColumns";

const extraChoice = (value: Extra, label: string, hint: string): Choice<Extra> => ({
  value,
  label,
  hint,
});

const TERMINAL_IO: InitIO = { ask, say: console.log, select, multiSelect };

const NO_PROMPT_IO: InitIO = {
  ask: () => null,
  say: () => {},
  select: (_question, choices, initial) => choices[initial].value,
  multiSelect: (_question, _choices, initial) => [...initial],
};

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

const question = async (
  io: Pick<InitIO, "ask" | "say">,
  text: string,
  fallback: string,
  error: (answer: string) => string | undefined,
): Promise<string> => {
  for (;;) {
    const answer = (await io.ask(text, fallback))?.trim();
    if (!answer) return fallback;
    const reason = error(answer);
    if (!reason) return answer;
    io.say(reason);
  }
};

export const collectAnswers = async (args: InitArgs, io: InitIO): Promise<InitAnswers> => {
  const database =
    args.database ??
    (await io.select(
      "Database engine",
      DATABASE_TYPES.map((value) => ({ value, label: DATABASE_LABELS[value] })),
      0,
    ));

  const dbName = args.dbName ?? (await question(io, "Database name", "app", dbNameError));

  // A SQLite project has no database server: no password, and no port to publish.
  const dbPassword =
    database === "sqlite"
      ? ""
      : await question(io, "Database password", generatePassword(), (answer) =>
          passwordError(database, answer),
        );

  const dbPort =
    database === "sqlite"
      ? 0
      : (args.dbPort ??
        Number(
          await question(
            io,
            "Database port on this host",
            String(ENGINES[database].port),
            portError,
          ),
        ));

  const extraChoices: Choice<Extra>[] = [
    ...(args.rabbitmq === undefined ? [extraChoice("rabbitmq", "RabbitMQ", "queues demo")] : []),
    ...(args.ai === undefined
      ? [extraChoice("ai", "AI agent", "natural-language queries, needs Ollama")]
      : []),
    ...(args.mcp === undefined
      ? [extraChoice("mcp", "MCP server", "tools for LLM clients at /mcp")]
      : []),
    ...(args.auth === undefined
      ? [extraChoice("auth", "Login", "two roles, reader and editor")]
      : []),
    ...(args.redis === undefined
      ? [extraChoice("redis", "Redis", "cache, token store, rate limits")]
      : []),
    ...(args.dataTools === undefined
      ? [extraChoice("dataTools", "Data tools", "dbgate, and Redis Commander with Redis")]
      : []),
    ...(args.frontend === undefined
      ? [extraChoice("frontend", "React frontend", "app at localhost:3000")]
      : []),
    ...(args.cron === undefined
      ? [extraChoice("cron", "Cron job", "logs the book count every minute")]
      : []),
    ...(args.rateLimit === undefined
      ? [extraChoice("rateLimit", "Rate limits", "requests a minute per caller")]
      : []),
    ...(args.metrics === undefined
      ? [extraChoice("metrics", "Metrics", "Prometheus /metrics behind its own secret")]
      : []),
    ...(args.tracing === undefined
      ? [extraChoice("tracing", "Tracing", "each request's spans in Jaeger")]
      : []),
    ...(args.virtualColumns === undefined
      ? [extraChoice("virtualColumns", "Computed column", "books.age, worked out in SQL")]
      : []),
  ];
  const extras =
    extraChoices.length === 0 ? [] : await io.multiSelect<Extra>("Select extras", extraChoices, []);
  const chosen = new Set(extras);

  return {
    database,
    dbName,
    dbPassword,
    dbPort,
    rabbitmq: args.rabbitmq ?? chosen.has("rabbitmq"),
    ai: args.ai ?? chosen.has("ai"),
    mcp: args.mcp ?? chosen.has("mcp"),
    auth: args.auth ?? chosen.has("auth"),
    redis: args.redis ?? chosen.has("redis"),
    dataTools: args.dataTools ?? chosen.has("dataTools"),
    frontend: args.frontend ?? chosen.has("frontend"),
    cron: args.cron ?? chosen.has("cron"),
    rateLimit: args.rateLimit ?? chosen.has("rateLimit"),
    metrics: args.metrics ?? chosen.has("metrics"),
    tracing: args.tracing ?? chosen.has("tracing"),
    virtualColumns: args.virtualColumns ?? chosen.has("virtualColumns"),
  };
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
  describe: { service: string; envVar: string },
  isFree: (port: number) => boolean = isPortFree,
): string | undefined => {
  if (isFree(port)) return undefined;
  let free = port + 1;
  while (free <= 65535 && !isFree(free)) free++;
  const suggestion = free <= 65535 ? ` such as ${free}` : "";
  return `Port ${port} is in use on this host, so Docker Compose cannot publish the ${describe.service} on it. Set ${describe.envVar} in .env to a free port${suggestion} before \`docker compose up\`.`;
};

export const sampleQuery = (
  answers: Pick<InitAnswers, "database" | "dbName" | "virtualColumns">,
): string => {
  const schema = seedSchema(answers);
  return `{ ${schema}_authors { name ${schema}_books { title${answers.virtualColumns ? " age" : ""} } } }`;
};

export const recreateCommand = (answers: InitAnswers, installed: boolean): string =>
  [
    "bunx graphoria init --yes",
    `--database ${answers.database}`,
    `--db-name ${answers.dbName}`,
    ...(answers.database === "sqlite" ? [] : [`--db-port ${answers.dbPort}`]),
    ...(answers.rabbitmq ? ["--rabbitmq"] : []),
    ...(answers.ai ? ["--ai"] : []),
    ...(answers.mcp ? ["--mcp"] : []),
    ...(answers.auth ? ["--auth"] : []),
    ...(answers.redis ? ["--redis"] : []),
    ...(answers.dataTools ? ["--data-tools"] : []),
    ...(answers.frontend ? ["--frontend"] : []),
    ...(answers.cron ? ["--cron"] : []),
    ...(answers.rateLimit ? ["--rate-limit"] : []),
    ...(answers.metrics ? ["--metrics"] : []),
    ...(answers.tracing ? ["--tracing"] : []),
    ...(answers.virtualColumns ? ["--virtual-columns"] : []),
    ...(installed ? [] : ["--no-install"]),
  ].join(" ");

export type Paint = Record<
  "code" | "url" | "name" | "secret" | "warning",
  (text: string) => string
>;

const plain = (text: string) => text;

export const PLAIN_PAINT: Paint = {
  code: plain,
  url: plain,
  name: plain,
  secret: plain,
  warning: plain,
};

const tint = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[39m`;

// 16-color codes (36 cyan, 94 bright blue, 33 yellow), not 256 or truecolor: the terminal's theme
// then chooses shades its background reads. Errors need none: on a terminal, Bun's console.error
// prints them red by itself.
export const COLOR_PAINT: Paint = {
  code: tint(36),
  url: tint(94),
  name: (text) => `\x1b[1m${text}\x1b[22m`,
  secret: tint(33),
  warning: tint(33),
};

// Bun.color's "ansi" weighs TERM, NO_COLOR and FORCE_COLOR but never the stream, and
// Bun.enableANSIColors holds while either stdout or stderr is a terminal: each stream decides alone.
export const paintFor = (
  stream: { isTTY?: boolean },
  ansi = Bun.color("white", "ansi"),
  forced = process.env.FORCE_COLOR !== undefined,
): Paint => (ansi && (stream.isTTY || forced) ? COLOR_PAINT : PLAIN_PAINT);

export const nextSteps = (
  answers: InitAnswers,
  installed: boolean,
  users?: { reader: string; editor: string },
  paint: Paint = PLAIN_PAINT,
) => {
  if (answers.auth && !users) throw new Error("nextSteps: auth needs the demo users' passwords");

  const command = (line: string) => `  ${paint.code(line)}`;
  const inline = (code: string) => paint.code(`\`${code}\``);
  const link = (port: number, path = "") => paint.url(`http://localhost:${port}${path}`);
  const seed = (role: "reader" | "editor", password: string) =>
    `  ${paint.code(`bunx graphoria seed-auth --user ${role} --password `)}${paint.secret(password)}${paint.code(` --role ${role} --config ./graphoria.ts`)}`;

  const open = answers.frontend
    ? `  then open ${link(3000)} (the app) or ${link(3000, "/graphiql")}`
    : `  then open ${link(3000, "/graphiql")}`;

  // Besides the database, what graphoria.ts connects to: a host run starts
  // their containers too.
  const services = [
    ...(answers.rabbitmq ? ["rabbitmq"] : []),
    ...(answers.redis ? ["redis"] : []),
    ...(answers.tracing ? ["jaeger"] : []),
  ].join(" ");

  const run =
    answers.database === "sqlite"
      ? [
          ...(installed ? [] : [`First run ${inline("bun install")}.`, ""]),
          `Run it on this machine; the first boot creates ${answers.dbName}.db and seeds it:`,
          ...(services ? [command(`docker compose up -d --wait ${services}`)] : []),
          command("bun run dev"),
          open,
          "",
          "Or in Docker, with the database file on a volume:",
          command("docker compose up -d --build"),
        ]
      : [
          ...(installed
            ? []
            : [`First run ${inline("bun install")}: the Dockerfile needs its bun.lock.`, ""]),
          "Run everything in Docker:",
          command("docker compose up -d --build"),
          open,
          "",
          "Or run Graphoria on the host against the database container:",
          command(
            answers.database === "mssql"
              ? "docker compose run --rm db-init"
              : `docker compose up -d --wait db${services ? ` ${services}` : ""}`,
          ),
          ...(answers.database === "mssql" && services
            ? [command(`docker compose up -d --wait ${services}`)]
            : []),
          command("bun run dev"),
        ];

  return [
    ...run,
    ...(answers.auth && users
      ? [
          "",
          `${paint.name("Two demo users")}, one per role. Once the database is up, create them:`,
          seed("reader", users.reader),
          seed("editor", users.editor),
          ...(answers.database === "sqlite"
            ? [
                `(SQLite in Docker: run them inside the container, prefixed with ${inline("docker compose exec graphoria")}.)`,
              ]
            : []),
          "Without a token you read the authors. A reader also reads the published books; an editor",
          "reads every book, adds drafts (addBook) and publishes them (publishBook).",
          "Log in with auth_login in GraphiQL or POST /rest/auth/login, then send",
          `Authorization: Bearer <access_token>${answers.frontend ? `, or sign in at ${link(3000)}` : ""}.`,
        ]
      : []),
    ...(answers.rabbitmq
      ? [
          "",
          `${paint.name("RabbitMQ")} management UI: ${link(RABBITMQ_MANAGEMENT_PORT)} (user RABBITMQ_USER, password RABBITMQ_PASSWORD from .env)`,
          `Publish with the events_bookAdded mutation; subscribe with events_onBookAdded.${answers.auth ? " Both take an editor's token or the admin secret." : ""}`,
          ...(answers.auth
            ? [
                "publishBook publishes events_bookPublished; a reader too subscribes with events_onBookPublished.",
              ]
            : []),
        ]
      : []),
    ...(answers.ai
      ? [
          "",
          `The ${paint.name("AI agent")} answers /rest/ai and GraphiQL's ask field${answers.auth ? " for a reader or an editor" : ""}.`,
          `Ollama must run on the host, so use ${paint.code("bun run dev")}, not ${paint.code("docker compose up")}.`,
        ]
      : []),
    ...(answers.mcp
      ? [
          "",
          `The ${paint.name("MCP server")} answers MCP clients at ${link(3000, "/mcp")}. Its tools run as the caller, as on /graphql:`,
          answers.auth
            ? "without a header a client reads the authors; send a reader's or an editor's token, or the admin secret."
            : answers.frontend
              ? "without a header a client reads what anyone reads; send the admin secret to read everything."
              : "without a header a client reads no table; send the admin secret.",
        ]
      : []),
    ...(answers.redis
      ? [
          "",
          answers.auth
            ? `${paint.name("Redis")} caches GET /rest/books, for a reader or an editor, behind each process's own copy (caches in graphoria.ts). AUTH_STORE in .env points the auth token store at it, and RATE_LIMIT_STORE the rate limits${answers.rateLimit ? "" : " once you turn them on"}. With ${paint.code("bun run dev")}, start it first: a token the server cannot check there reads as no token.`
            : `${paint.name("Redis")} caches GET /rest/books behind each process's own copy (caches in graphoria.ts). ${answers.rateLimit ? "RATE_LIMIT_STORE in .env points the rate limits at it, and AUTH_STORE the auth token store once you turn auth on." : "AUTH_STORE and RATE_LIMIT_STORE in .env point the auth token store and the rate limits at it once you turn them on."}`,
        ]
      : []),
    ...(answers.dataTools
      ? [
          "",
          `${paint.name("dbgate")} explores the database at ${link(DBGATE_PORT)} once ${inline("docker compose up")} runs it.`,
          ...(answers.redis
            ? [`${paint.name("Redis Commander")} inspects Redis at ${link(REDIS_COMMANDER_PORT)}.`]
            : []),
        ]
      : []),
    ...(answers.frontend
      ? [
          "",
          `Once ${inline("bun run dev")} has printed the schema, ${inline("bun run types")} writes`,
          "web/graphql-env.d.ts, which types the app's queries. Commit it.",
        ]
      : []),
    ...(answers.cron
      ? [
          "",
          `The ${paint.name("cron job")} booksReport (cron in graphoria.ts) logs the number of books${answers.auth ? " and of drafts" : ""} every minute; in Docker, read it with ${paint.code("docker compose logs -f graphoria")}.`,
        ]
      : []),
    ...(answers.rateLimit
      ? [
          "",
          `${paint.name("Rate limits")}: an anonymous caller gets 60 requests a minute per address (${answers.auth || answers.frontend ? "rateLimit in graphoria.ts" : "RATE_LIMIT_ANONYMOUS_MAX in .env"}), any other caller 600, the admin secret included (RATE_LIMIT_MAX in .env); past that, 429 with Retry-After. ${answers.redis ? "Redis holds the counts, shared by every process." : "Each process counts on its own."}`,
        ]
      : []),
    ...(answers.metrics
      ? [
          "",
          `${paint.name("Metrics")}: ${link(3000, "/metrics")} answers Prometheus when the x-admin-secret header carries METRICS_SECRET from .env, a secret that opens nothing else.`,
        ]
      : []),
    ...(answers.tracing
      ? [
          "",
          `${paint.name("Jaeger")} shows a trace for each request, down to the SQL it ran, at ${link(JAEGER_UI_PORT)}: pick the service named OTEL_SERVICE_NAME in .env.`,
        ]
      : []),
    ...(answers.virtualColumns
      ? [
          "",
          `${paint.name("Computed column")}: each book's age, the years since it was published, is worked out by the database on every read (schema in graphoria.ts) and never stored.`,
        ]
      : []),
    "",
    "The admin secret is ADMIN_SECRET in .env; send it in the x-admin-secret header.",
    `Try${answers.auth ? ", as a reader, an editor or with the admin secret" : ""}: ${paint.code(sampleQuery(answers))}`,
    "",
    "Recreate this setup in a new directory without prompts (the secrets are regenerated):",
    command(recreateCommand(answers, installed)),
  ].join("\n");
};

const USAGE =
  "Usage: graphoria init [--yes] [--database pg|mysql|mssql|sqlite] [--db-name <name>] [--db-port <port>] [--rabbitmq] [--ai] [--mcp] [--auth] [--redis] [--data-tools] [--frontend] [--cron] [--rate-limit] [--metrics] [--tracing] [--virtual-columns] [--no-install]";

const noTerminal = (question: string): never => {
  console.error(`init: no terminal to ask "${question}" in, so nothing was written.`);
  console.error(
    "Run it in a terminal, without piping or redirecting it, or pass --yes to take the defaults, with flags for the rest:",
  );
  console.error(USAGE);
  process.exit(2);
};

const NO_TERMINAL_IO: InitIO = {
  ask: noTerminal,
  say: () => {},
  select: noTerminal,
  multiSelect: noTerminal,
};

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
  const refuseExisting = (paths: readonly string[]) => {
    const conflicts = findConflicts(dir, paths);
    if (conflicts.length === 0) return;
    console.error("init: these files already exist, so nothing was written:");
    for (const path of conflicts) console.error(`  ${path}`);
    process.exit(1);
  };

  refuseExisting([...PROJECT_FILES, "bun.lock"]);
  const io = args.yes ? NO_PROMPT_IO : interactive() ? TERMINAL_IO : NO_TERMINAL_IO;
  const answers = await collectAnswers(args, io);
  if (answers.frontend) refuseExisting(FRONTEND_FILES);
  const warnings = [
    answers.database === "sqlite"
      ? undefined
      : portWarning(answers.dbPort, { service: "database", envVar: "DB_PORT" }),
    answers.rabbitmq
      ? portWarning(RABBITMQ_PORT, { service: "RabbitMQ", envVar: "RABBITMQ_PORT" })
      : undefined,
    answers.rabbitmq
      ? portWarning(RABBITMQ_MANAGEMENT_PORT, {
          service: "RabbitMQ management UI",
          envVar: "RABBITMQ_MANAGEMENT_PORT",
        })
      : undefined,
    answers.dataTools
      ? portWarning(DBGATE_PORT, { service: "dbgate", envVar: "DBGATE_PORT" })
      : undefined,
    answers.dataTools && answers.redis
      ? portWarning(REDIS_COMMANDER_PORT, {
          service: "Redis Commander",
          envVar: "REDIS_COMMANDER_PORT",
        })
      : undefined,
    answers.tracing
      ? portWarning(JAEGER_UI_PORT, { service: "Jaeger UI", envVar: "JAEGER_UI_PORT" })
      : undefined,
  ];
  const stderrPaint = paintFor(process.stderr);
  for (const warning of warnings) if (warning) console.warn(stderrPaint.warning(warning));

  const name = projectName(dir);
  // Printed with the seed-auth commands only: not in .env, never in recreateCommand.
  const users = answers.auth
    ? { reader: generatePassword(), editor: generatePassword() }
    : undefined;
  const files = renderProject(
    {
      ...answers,
      name,
      adminSecret: generateSecret(),
      jwtSecret: generateSecret(),
      rabbitmqPassword: generatePassword(),
      metricsSecret: generateSecret(),
    },
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
  const label = answers.database === "sqlite" ? "SQLite" : ENGINES[answers.database].label;
  console.log(`\nCreated ${name} (${label}): ${written.join(", ")}\n`);

  if (args.install) {
    console.log("Installing dependencies (bun install)…");
    // --silent drops the progress and the package list, though a failed install still prints
    // Bun's error. --no-env-file drops the line naming the .env just written, which the install
    // reads nothing from (Bun 1.4.2 ignores the flag and prints the line).
    const install = Bun.spawn(["bun", "install", "--silent", "--no-env-file"], {
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

  console.log(nextSteps(answers, args.install, users, paintFor(process.stdout)));
  process.exit(0);
};

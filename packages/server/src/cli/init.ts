import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { customAlphabet } from "nanoid";

import type { DatabaseType } from "../config";
import type { InitArgs } from "./initArgs";
import type { HostPorts, InitAnswers } from "./initTemplates";
import type { Ask, Choice, MultiSelect, Say, Select } from "./prompt";

import { version } from "../../package.json";
import { DATABASE_TYPES, dbNameError, parseInitArgs, portError } from "./initArgs";
import {
  DEFAULT_PORTS,
  ENGINES,
  FRONTEND_FILES,
  GRAFANA_FILES,
  METRICS_FILES,
  PROJECT_FILES,
  TRPC_ENV_FILES,
  TRPC_FILES,
  renderProject,
  seedSchema,
} from "./initTemplates";
import { ask, interactive, multiSelect, select } from "./prompt";

export type InitIO = {
  ask: Ask;
  say: Say;
  select: Select;
  multiSelect: MultiSelect;
  isPortFree: (port: number) => boolean;
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
  | "trpc"
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

export const isPortFree = (port: number): boolean => {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

const TERMINAL_IO: InitIO = { ask, say: console.log, select, multiSelect, isPortFree };

const NO_PROMPT_IO: InitIO = {
  ask: () => null,
  say: () => {},
  select: (_question, choices, initial) => choices[initial].value,
  multiSelect: (_question, _choices, initial) => [...initial],
  isPortFree,
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

  let dbPort = 0;
  let dbPortGiven = false;
  if (database !== "sqlite") {
    if (args.dbPort !== undefined) {
      dbPort = args.dbPort;
      dbPortGiven = true;
    } else {
      const offered = freePort(ENGINES[database].port, new Set(), io.isPortFree);
      dbPort = Number(await question(io, "Database port on this host", String(offered), portError));
      dbPortGiven = dbPort !== offered;
    }
  }

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
    ...(args.trpc === undefined
      ? [extraChoice("trpc", "tRPC", "operations as typed procedures at /trpc")]
      : []),
    ...(args.cron === undefined
      ? [extraChoice("cron", "Cron job", "logs the book count every minute")]
      : []),
    ...(args.rateLimit === undefined
      ? [extraChoice("rateLimit", "Rate limits", "requests a minute per caller")]
      : []),
    ...(args.metrics === undefined
      ? [extraChoice("metrics", "Metrics", "Prometheus and a Grafana dashboard")]
      : []),
    ...(args.tracing === undefined
      ? [extraChoice("tracing", "Tracing", "spans per request in Jaeger and Grafana")]
      : []),
    ...(args.virtualColumns === undefined
      ? [extraChoice("virtualColumns", "Computed column", "books.age, worked out in SQL")]
      : []),
  ];
  const extras =
    extraChoices.length === 0 ? [] : await io.multiSelect<Extra>("Select extras", extraChoices, []);
  const chosen = new Set(extras);

  const answers = {
    database,
    dbName,
    dbPassword,
    dbPort,
    dbPortGiven,
    rabbitmq: args.rabbitmq ?? chosen.has("rabbitmq"),
    ai: args.ai ?? chosen.has("ai"),
    mcp: args.mcp ?? chosen.has("mcp"),
    auth: args.auth ?? chosen.has("auth"),
    redis: args.redis ?? chosen.has("redis"),
    dataTools: args.dataTools ?? chosen.has("dataTools"),
    frontend: args.frontend ?? chosen.has("frontend"),
    trpc: args.trpc ?? chosen.has("trpc"),
    cron: args.cron ?? chosen.has("cron"),
    rateLimit: args.rateLimit ?? chosen.has("rateLimit"),
    metrics: args.metrics ?? chosen.has("metrics"),
    tracing: args.tracing ?? chosen.has("tracing"),
    virtualColumns: args.virtualColumns ?? chosen.has("virtualColumns"),
  };
  return { ...answers, ports: pickPorts(answers, io.isPortFree) };
};

// The first port from `preferred` up that is free and not in `taken`.
const freePort = (
  preferred: number,
  taken: ReadonlySet<number>,
  isFree: (port: number) => boolean,
): number => {
  for (let port = preferred; port <= 65535; port++) {
    if (!taken.has(port) && isFree(port)) return port;
  }
  return preferred;
};

// What the project publishes besides its database, in the order the ports are
// handed out, and the .env variable each one lands in.
const PUBLISHED: { key: keyof HostPorts; service: string; envVar: string }[] = [
  { key: "app", service: "Graphoria", envVar: "PORT" },
  { key: "redis", service: "Redis", envVar: "REDIS_PORT" },
  { key: "rabbitmq", service: "RabbitMQ", envVar: "RABBITMQ_PORT" },
  {
    key: "rabbitmqManagement",
    service: "RabbitMQ's management UI",
    envVar: "RABBITMQ_MANAGEMENT_PORT",
  },
  { key: "dbgate", service: "dbgate", envVar: "DBGATE_PORT" },
  { key: "redisCommander", service: "Redis Commander", envVar: "REDIS_COMMANDER_PORT" },
  { key: "jaegerUi", service: "Jaeger's UI", envVar: "JAEGER_UI_PORT" },
  { key: "jaegerOtlp", service: "Jaeger's OTLP receiver", envVar: "JAEGER_OTLP_PORT" },
  { key: "grafana", service: "Grafana", envVar: "GRAFANA_PORT" },
];

// Each published port: its default when free, else the next free one that no
// other service, the database included, already took. A service the project
// leaves out keeps its default, unprobed.
export const pickPorts = (
  answers: Pick<
    InitAnswers,
    "database" | "dbPort" | "redis" | "rabbitmq" | "dataTools" | "metrics" | "tracing"
  >,
  isFree: (port: number) => boolean,
): HostPorts => {
  const published: Record<keyof HostPorts, boolean> = {
    app: true,
    redis: answers.redis,
    rabbitmq: answers.rabbitmq,
    rabbitmqManagement: answers.rabbitmq,
    dbgate: answers.dataTools,
    redisCommander: answers.dataTools && answers.redis,
    jaegerUi: answers.tracing,
    jaegerOtlp: answers.tracing,
    grafana: answers.metrics || answers.tracing,
  };
  const taken = new Set(answers.database === "sqlite" ? [] : [answers.dbPort]);
  const ports = { ...DEFAULT_PORTS };
  for (const { key } of PUBLISHED) {
    if (!published[key]) continue;
    ports[key] = freePort(DEFAULT_PORTS[key], taken, isFree);
    taken.add(ports[key]);
  }
  return ports;
};

export const portWarning = (
  port: number,
  describe: { service: string; envVar: string },
  isFree: (port: number) => boolean = isPortFree,
): string | undefined => {
  if (isFree(port)) return undefined;
  const taken = `Port ${port} is in use on this host, so Docker Compose cannot publish the ${describe.service} on it.`;
  let free = port + 1;
  while (free <= 65535 && !isFree(free)) free++;
  const suggestion = free <= 65535 ? ` such as ${free}` : "";
  return `${taken} Set ${describe.envVar} in .env to a free port${suggestion} before \`docker compose up\`.`;
};

const moved = (from: number, service: string, to: number, envVar: string) =>
  `Port ${from} is taken, so ${service} uses ${to} instead (${envVar} in .env).`;

// What init says about the ports: the ones it moved off a taken default, and a
// database port that is itself taken (one --db-port or the question chose).
export const portNotes = (
  answers: InitAnswers,
  isFree: (port: number) => boolean = isPortFree,
): string[] => {
  const notes: string[] = [];
  if (answers.database !== "sqlite") {
    const engine = ENGINES[answers.database].port;
    const warning = portWarning(answers.dbPort, { service: "database", envVar: "DB_PORT" }, isFree);
    if (warning) notes.push(warning);
    else if (!answers.dbPortGiven && answers.dbPort !== engine && !isFree(engine))
      notes.push(moved(engine, "the database", answers.dbPort, "DB_PORT"));
  }
  for (const { key, service, envVar } of PUBLISHED) {
    if (answers.ports[key] !== DEFAULT_PORTS[key])
      notes.push(moved(DEFAULT_PORTS[key], service, answers.ports[key], envVar));
  }
  return notes;
};

export const sampleQuery = (
  answers: Pick<InitAnswers, "database" | "dbName" | "virtualColumns">,
): string => {
  const schema = seedSchema(answers);
  return `{ ${schema}_authors { name ${schema}_books { title${answers.virtualColumns ? " age" : ""} } } }`;
};

export const recreateCommand = (answers: InitAnswers, installed: boolean, up = false): string =>
  [
    "bunx graphoria init --yes",
    `--database ${answers.database}`,
    `--db-name ${answers.dbName}`,
    ...(answers.database !== "sqlite" && answers.dbPortGiven
      ? [`--db-port ${answers.dbPort}`]
      : []),
    ...(answers.rabbitmq ? ["--rabbitmq"] : []),
    ...(answers.ai ? ["--ai"] : []),
    ...(answers.mcp ? ["--mcp"] : []),
    ...(answers.auth ? ["--auth"] : []),
    ...(answers.redis ? ["--redis"] : []),
    ...(answers.dataTools ? ["--data-tools"] : []),
    ...(answers.frontend ? ["--frontend"] : []),
    ...(answers.trpc ? ["--trpc"] : []),
    ...(answers.cron ? ["--cron"] : []),
    ...(answers.rateLimit ? ["--rate-limit"] : []),
    ...(answers.metrics ? ["--metrics"] : []),
    ...(answers.tracing ? ["--tracing"] : []),
    ...(answers.virtualColumns ? ["--virtual-columns"] : []),
    ...(installed ? [] : ["--no-install"]),
    ...(up ? ["--up"] : []),
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

// What runs the project in Docker: `bun run up` writes the types first, where
// the project has them.
export const upCommand = ({ frontend, trpc }: Pick<InitAnswers, "frontend" | "trpc">): string[] =>
  frontend || trpc ? ["bun", "run", "up"] : ["docker", "compose", "up", "-d", "--build"];

export const nextSteps = (
  answers: InitAnswers,
  installed: boolean,
  users?: { reader: string; editor: string },
  paint: Paint = PLAIN_PAINT,
  up = false,
) => {
  if (answers.auth && !users) throw new Error("nextSteps: auth needs the demo users' passwords");

  const command = (line: string) => `  ${paint.code(line)}`;
  const inline = (code: string) => paint.code(`\`${code}\``);
  const link = (port: number, path = "") => paint.url(`http://localhost:${port}${path}`);
  const { ports } = answers;
  const seed = (role: "reader" | "editor", password: string) =>
    `  ${paint.code(`bunx graphoria seed-auth --user ${role} --password `)}${paint.secret(password)}${paint.code(` --role ${role} --config ./graphoria.ts`)}`;

  const open = answers.frontend
    ? `  then open ${link(ports.app)} (the app) or ${link(ports.app, "/graphiql")}`
    : `  then open ${link(ports.app, "/graphiql")}`;

  // Besides the database, what graphoria.ts connects to: a host run starts
  // their containers too, and Grafana, which shows the traces Jaeger keeps.
  const services = [
    ...(answers.rabbitmq ? ["rabbitmq"] : []),
    ...(answers.redis ? ["redis"] : []),
    ...(answers.tracing ? ["jaeger", "grafana"] : []),
  ].join(" ");

  const typesScript = answers.frontend || answers.trpc;

  const run =
    answers.database === "sqlite"
      ? [
          ...(installed ? [] : [`First run ${inline("bun install")}.`, ""]),
          `Run it on this machine; the first ${typesScript ? inline("bun run types") : "boot"} creates ${answers.dbName}.db and seeds it:`,
          ...(services ? [command(`docker compose up -d --wait ${services}`)] : []),
          ...(typesScript ? [command("bun run types")] : []),
          command("bun run dev"),
          open,
          "",
          "Or in Docker, with the database file on a volume:",
          command(upCommand(answers).join(" ")),
        ]
      : [
          ...(installed
            ? []
            : [`First run ${inline("bun install")}: the Dockerfile needs its bun.lock.`, ""]),
          "Run everything in Docker:",
          command(upCommand(answers).join(" ")),
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
          ...(typesScript ? [command("bun run types")] : []),
          command("bun run dev"),
        ];

  const grafana = answers.metrics
    ? `${paint.name("Grafana")} opens on the Graphoria dashboard at ${link(ports.grafana)} in the Docker run: Prometheus scrapes the graphoria service, not a host run${answers.tracing ? "; the traces are under Explore → Jaeger" : ""}.`
    : `${paint.name("Grafana")} shows the traces at ${link(ports.grafana)}, under Explore → Jaeger.`;

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
          `Authorization: Bearer <access_token>${answers.frontend ? `, or sign in at ${link(ports.app)}` : ""}.`,
        ]
      : []),
    ...(answers.rabbitmq
      ? [
          "",
          `${paint.name("RabbitMQ")} management UI: ${link(ports.rabbitmqManagement)} (user RABBITMQ_USER, password RABBITMQ_PASSWORD from .env)`,
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
          `The ${paint.name("MCP server")} answers MCP clients at ${link(ports.app, "/mcp")}. Its tools run as the caller, as on /graphql:`,
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
          `${paint.name("dbgate")} explores the database at ${link(ports.dbgate)} once ${inline("docker compose up")} runs it.`,
          ...(answers.redis
            ? [`${paint.name("Redis Commander")} inspects Redis at ${link(ports.redisCommander)}.`]
            : []),
        ]
      : []),
    ...(typesScript
      ? [
          "",
          `${inline("bun run types")} reads the database, with no server running, and writes`,
          `${[
            ...(answers.frontend ? ["web/graphql-env.d.ts, which types the app's queries"] : []),
            ...(answers.trpc
              ? ["graphoria-env.d.ts, which types the plain-string operations"]
              : []),
          ].join(
            ", and ",
          )}. Commit ${answers.frontend && answers.trpc ? "both" : "it"}, and run it again`,
          "after a change to the tables or to graphoria.ts.",
        ]
      : []),
    ...(answers.trpc
      ? [
          "",
          `${paint.name("tRPC")} serves the operations at ${link(ports.app, "/trpc")} (TRPC_ENABLED in .env); a call runs as its caller, as on /rest.`,
          `A client made with @trpc/client types them from graphoria.ts through TRPCRouterOf from @graphoria/server/trpc${answers.auth && answers.frontend ? ", as web/trpc.ts does for the app's Publish button" : ""}.`,
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
          `${paint.name("Metrics")}: ${link(ports.app, "/metrics")} answers Prometheus when the x-admin-secret header carries METRICS_SECRET from .env, a secret that opens nothing else.`,
        ]
      : []),
    ...(answers.tracing
      ? [
          "",
          `${paint.name("Jaeger")} shows a trace for each request, down to the SQL it ran, at ${link(ports.jaegerUi)}: pick the service named OTEL_SERVICE_NAME in .env.`,
        ]
      : []),
    ...(answers.metrics || answers.tracing ? [grafana] : []),
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
    command(recreateCommand(answers, installed, up)),
  ].join("\n");
};

const USAGE =
  "Usage: graphoria init [--yes] [--database pg|mysql|mssql|sqlite] [--db-name <name>] [--db-port <port>] [--rabbitmq] [--ai] [--mcp] [--auth] [--redis] [--data-tools] [--frontend] [--trpc] [--cron] [--rate-limit] [--metrics] [--tracing] [--virtual-columns] [--no-install] [--up]";

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
  isPortFree,
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
  if (answers.frontend)
    refuseExisting([...FRONTEND_FILES, ...(answers.auth && answers.trpc ? TRPC_FILES : [])]);
  if (answers.trpc) refuseExisting([...TRPC_ENV_FILES]);
  if (answers.metrics || answers.tracing)
    refuseExisting([...(answers.metrics ? METRICS_FILES : []), ...GRAFANA_FILES]);
  const stderrPaint = paintFor(process.stderr);
  for (const note of portNotes(answers, io.isPortFree)) console.warn(stderrPaint.warning(note));

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

  const up = upCommand(answers).join(" ");
  let upFailed = false;
  if (args.up) {
    console.log(`Starting it in Docker (${up})…`);
    try {
      const run = Bun.spawn(upCommand(answers), {
        cwd: dir,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      upFailed = (await run.exited) !== 0;
    } catch (error) {
      // Bun.spawn throws when the command is not on the PATH: docker, without Docker.
      console.error(`init: ${error instanceof Error ? error.message : String(error)}`);
      upFailed = true;
    }
    console.log("");
  }

  // The steps print even when --up failed: they carry the demo users' passwords.
  console.log(nextSteps(answers, args.install, users, paintFor(process.stdout), args.up));
  if (upFailed) {
    console.error(
      `init: ${up} failed. The project is written and installed: fix the error above, then run \`${up}\`.`,
    );
    process.exit(1);
  }
  process.exit(0);
};

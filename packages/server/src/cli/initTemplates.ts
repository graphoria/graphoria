import type { DatabaseType } from "../config";

export type InitAnswers = {
  database: DatabaseType;
  dbName: string;
  dbPassword: string;
  dbPort: number;
  rabbitmq: boolean;
  ai: boolean;
  redis: boolean;
  dataTools: boolean;
  frontend: boolean;
};

export type ProjectValues = InitAnswers & {
  name: string;
  adminSecret: string;
  jwtSecret: string;
  rabbitmqPassword: string;
};

export type Versions = { graphoria: string; bun: string };

type Engine = { label: string; user: string; port: number; image: string; data: string };

/** The engines reached over the network, as opposed to SQLite's file. */
type ServerEngine = Exclude<DatabaseType, "sqlite">;

export const ENGINES: Record<ServerEngine, Engine> = {
  pg: {
    label: "PostgreSQL",
    user: "postgres",
    port: 5432,
    image: "postgres:18",
    data: "/var/lib/postgresql",
  },
  mysql: { label: "MySQL", user: "root", port: 3306, image: "mysql:8", data: "/var/lib/mysql" },
  mssql: {
    label: "SQL Server",
    user: "sa",
    port: 1433,
    image: "mcr.microsoft.com/mssql/server:2022-latest",
    data: "/var/opt/mssql",
  },
};

// dbgate names its engine as `<driver>@<plugin>`.
const DBGATE_ENGINES: Record<ServerEngine, string> = {
  pg: "postgres@dbgate-plugin-postgres",
  mysql: "mysql@dbgate-plugin-mysql",
  mssql: "mssql@dbgate-plugin-mssql",
};

export const RABBITMQ_PORT = 5672;
export const RABBITMQ_MANAGEMENT_PORT = 15672;

// The host port dbgate's single-page app is published on; it listens on 3000
// inside its own container, which Graphoria already took on the host.
export const DBGATE_PORT = 9000;

// Redis Commander's own default port.
export const REDIS_COMMANDER_PORT = 8081;

export const PROJECT_FILES = [
  "package.json",
  "tsconfig.json",
  "graphoria.ts",
  "index.ts",
  ".env",
  ".gitignore",
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "seed.sql",
] as const;

export const FRONTEND_FILES = [
  "bunfig.toml",
  "web/index.html",
  "web/frontend.tsx",
  "web/App.tsx",
  "web/graphql.ts",
  "web/styles.css",
] as const;

// The seed's schema, which prefixes its field names under the default
// `{schema}_{name}` field naming; a MySQL schema is its database.
export const seedSchema = ({ database, dbName }: Pick<InitAnswers, "database" | "dbName">) =>
  ({ pg: "public", mysql: dbName, mssql: "dbo", sqlite: "main" })[database];

// Exact versions. A test holds React and Tailwind to packages/playgrounds, which
// dependabot bumps; urql and gql.tada are bumped here by hand. Runtime
// dependencies, not dev: the image installs with --production and Bun bundles
// the app when the server starts.
const FRONTEND_DEPENDENCIES = {
  "bun-plugin-tailwind": "0.1.2",
  "gql.tada": "1.11.3",
  react: "19.3.0",
  "react-dom": "19.3.0",
  tailwindcss: "4.3.3",
  urql: "5.0.4",
};

const FRONTEND_DEV_DEPENDENCIES = { "@types/react": "19.3.0", "@types/react-dom": "19.3.0" };

// The queue demo's websocket subscription client; urql core already rides
// along as urql's dependency, declared here because App.tsx imports it.
const FRONTEND_QUEUE_DEPENDENCIES = {
  "@urql/core": "6.0.3",
  "graphql-ws": "6.3.0",
};

const packageJson = ({ name, rabbitmq, ai, frontend }: ProjectValues, { graphoria }: Versions) =>
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: frontend
        ? {
            dev: "PRINT_SCHEMAS=true bun --watch index.ts",
            start: "bun index.ts",
            types: "gql-tada generate output",
          }
        : { dev: "bun --watch index.ts", start: "bun index.ts" },
      dependencies: {
        "@graphoria/server": `^${graphoria}`,
        ...(rabbitmq && { "@graphoria/queues": `^${graphoria}` }),
        ...(ai && { "@graphoria/ai": `^${graphoria}` }),
        ...(frontend && FRONTEND_DEPENDENCIES),
        ...(frontend && rabbitmq && FRONTEND_QUEUE_DEPENDENCIES),
      },
      devDependencies: {
        "@types/bun": "latest",
        ...(frontend && FRONTEND_DEV_DEPENDENCIES),
        typescript: "^6.0.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
`;

const TSCONFIG_FRONTEND = `{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "plugins": [
      {
        "name": "gql.tada/ts-plugin",
        "schema": "./.graphoria/schemas/schema_anonymous.graphql",
        "tadaOutputLocation": "./web/graphql-env.d.ts"
      }
    ]
  }
}
`;

const MYSQL_CONNECTION_OPTIONS = `      // MySQL 8 authenticates with caching_sha2_password, whose RSA key
      // exchange Bun's client refuses over plain TCP unless allowed.
      connectionOptions: { allowPublicKeyRetrieval: true },
`;

const SERVER_CONNECTION = `      connection: {
        host: env("DB_HOST"),
        port: Number(env("DB_PORT")),
        user: env("DB_USER"),
        password: env("DB_PASSWORD"),
        database: env("DB_NAME"),
      },
`;

const SQLITE_CONNECTION = `      connection: { filename: env("DB_FILE") },
      // The first boot creates the tables: seed.sql runs while the file has none.
      onConnect: async (db) => {
        if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'authors'").get()) {
          db.run(await Bun.file(new URL("./seed.sql", import.meta.url)).text());
        }
      },
`;

const anonymousGrant = (values: ProjectValues) => {
  const schema = seedSchema(values);
  const permission =
    values.rabbitmq || values.ai
      ? `{
        tables: ["${schema}_authors", "${schema}_books"],
${values.rabbitmq ? '        queues: ["events"],\n' : ""}${values.rabbitmq && values.frontend ? '        operations: ["addBook"],\n' : ""}${values.ai ? "        ai: true,\n" : ""}      }`
      : `{ tables: ["${schema}_authors", "${schema}_books"] }`;
  return `  // The frontend has no login, so anyone can read these two tables without a
  // secret, in the app and in GraphiQL alike. Tables are read-only in the
  // generated API.
  auth: {
    enabled: false,
    database: "main",
    permissions: {
      anonymous: ${permission},
    },
  },
`;
};

const QUEUE_CONFIG = `  queues: [
    {
      type: "rabbitmq",
      name: "events",
      enabled: true,
      autoSetup: true,
      connection: {
        hostname: env("RABBITMQ_HOST"),
        port: Number(env("RABBITMQ_PORT")),
        username: env("RABBITMQ_USER"),
        password: env("RABBITMQ_PASSWORD"),
        vhost: env("RABBITMQ_VHOST"),
      },
      // The publisher is a mutation (events_bookAdded); the subscriber is a
      // subscription (events_onBookAdded) and consumes the queue.
      publishers: {
        bookAdded: { topic: "books", routingKey: "book.added", persistent: true },
      },
      subscribers: {
        onBookAdded: {
          topic: "books",
          pattern: "book.*",
          handler: (message) => {
            console.log("[events] book added:", message);
          },
        },
      },
      topics: {
        books: { type: "topic", durable: true },
      },
    },
  ],
`;

// Insert statements per engine, interpolated into the addBook handler below.
const ADD_BOOK_INSERT: Record<DatabaseType, string> = {
  pg: `        await databases.main.unsafe(
          \`INSERT INTO books (title, published_year, author_id) VALUES ($1, $2, $3)\`,
          [input.title, input.publishedYear, input.authorId],
        );`,
  mysql: `        await databases.main.unsafe(
          \`INSERT INTO books (title, published_year, author_id) VALUES (?, ?, ?)\`,
          [input.title, input.publishedYear, input.authorId],
        );`,
  mssql: `        await databases.main
          .request()
          .input("title", input.title)
          .input("publishedYear", input.publishedYear)
          .input("authorId", input.authorId)
          .query(
            \`INSERT INTO books (title, published_year, author_id) VALUES (@title, @publishedYear, @authorId)\`,
          );`,
  sqlite: `        databases.main
          .query(
            \`INSERT INTO books (title, published_year, author_id) VALUES (?, ?, ?)\`,
          )
          .run(input.title, input.publishedYear, input.authorId);`,
};

const ADD_BOOK_OPERATION = (values: ProjectValues) => `  operations: {
    // The frontend posts a new book here; after the insert, the handler publishes
    // events_bookAdded, the queued event the frontend's subscription watches.
    addBook: operation({
      input: addBookInput,
      rest: {
        path: "/add-book",
        method: "POST",
        body: addBookInput,
      },
      handler: async ({ databases, queues }, input) => {
${ADD_BOOK_INSERT[values.database]}
        queues.sendMessage("events_bookAdded", {
          title: input.title,
          publishedYear: input.publishedYear,
          authorId: input.authorId,
        });
        return input;
      },
    }),
  },
`;

const AI_CONFIG = `  ai: {
    enabled: true,
  },
`;

const graphoriaConfig = (values: ProjectValues) => `${
  values.frontend && values.rabbitmq
    ? 'import { operation, z } from "@graphoria/server/config";\n'
    : ""
}import type { ConfigurationFn } from "@graphoria/server/config";

// Bun loads these from .env; in Docker Compose they come from the environment.
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(\`\${name} is not set (see .env)\`);
  return value;
};
${
  values.frontend && values.rabbitmq
    ? `// The body of POST /rest/add-book and of the addBook GraphQL mutation.
const addBookInput = z.object({
  title: z.string().min(1),
  publishedYear: z.number().int(),
  authorId: z.number().int(),
});

`
    : ""
}export default (() => ({
  name: ${JSON.stringify(values.name)},
  version: "1.0.0",
  databases: [
    {
      name: "main",
      type: "${values.database}",
      enabled: true,
${values.database === "sqlite" ? SQLITE_CONNECTION : SERVER_CONNECTION}${values.database === "mysql" ? MYSQL_CONNECTION_OPTIONS : ""}    },
  ],
${values.rabbitmq ? QUEUE_CONFIG : ""}${values.ai ? AI_CONFIG : ""}${values.frontend && values.rabbitmq ? ADD_BOOK_OPERATION(values) : ""}${values.frontend ? anonymousGrant(values) : ""}})) satisfies ConfigurationFn;
`;

const INDEX = `import { createBunServer } from "@graphoria/server";

// No \`port\` here: the server listens on PORT (default 3000), the port the
// image's healthcheck probes.
const { server, prefixes } = await createBunServer({
  configuration: "./graphoria.ts",
});

console.log(\`GraphQL  → http://localhost:\${server.port}\${prefixes.graphql}\`);
console.log(\`REST     → http://localhost:\${server.port}\${prefixes.rest}\`);
console.log(\`GraphiQL → http://localhost:\${server.port}\${prefixes.graphiql}\`);
console.log(\`Scalar   → http://localhost:\${server.port}\${prefixes.scalar}\`);
`;

const INDEX_FRONTEND = `import { createHandlers } from "@graphoria/server";

import web from "./web/index.html";

// No \`port\` here: the server listens on PORT (default 3000), the port the
// image's healthcheck probes.
const { serverHandlers, prefixes, handleSignals } = await createHandlers({
  configuration: "./graphoria.ts",
});

const server = Bun.serve({
  ...serverHandlers,
  // The app on "/" alone: a catch-all would replace Graphoria's CORS preflight route.
  routes: { ...serverHandlers.routes, "/": web },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});
// SIGTERM / SIGINT: finish in-flight requests, close connections, exit.
handleSignals(server);

console.log(\`Frontend → http://localhost:\${server.port}\`);
console.log(\`GraphQL  → http://localhost:\${server.port}\${prefixes.graphql}\`);
console.log(\`REST     → http://localhost:\${server.port}\${prefixes.rest}\`);
console.log(\`GraphiQL → http://localhost:\${server.port}\${prefixes.graphiql}\`);
console.log(\`Scalar   → http://localhost:\${server.port}\${prefixes.scalar}\`);
`;

const rabbitmqEnv = (values: ProjectValues) =>
  values.rabbitmq
    ? `RABBITMQ_HOST=localhost
RABBITMQ_PORT=5672
RABBITMQ_MANAGEMENT_PORT=15672
RABBITMQ_USER=graphoria
RABBITMQ_PASSWORD=${values.rabbitmqPassword}
RABBITMQ_VHOST=/
`
    : "";

const aiEnv = (values: ProjectValues) =>
  values.ai
    ? `LLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# DEEPSEEK_API_KEY=
# LLM_MODEL=
`
    : "";

const redisEnv = (values: ProjectValues) =>
  values.redis
    ? `REDIS_URL=redis://localhost:6379
CACHE_STORE=redis
`
    : "";

const dataToolsEnv = (values: ProjectValues) =>
  values.dataTools
    ? `DBGATE_PORT=${DBGATE_PORT}
${values.redis ? `REDIS_COMMANDER_PORT=${REDIS_COMMANDER_PORT}\n` : ""}`
    : "";

const sqliteDotEnv = (
  values: ProjectValues,
) => `# Secrets and the database file, read by Bun on the host and by Docker Compose.
# Keep this file out of git.
ADMIN_SECRET=${values.adminSecret}
JWT_SECRET=${values.jwtSecret}
DB_FILE=${values.dbName}.db
${rabbitmqEnv(values)}${aiEnv(values)}${redisEnv(values)}${dataToolsEnv(values)}`;

const dotEnv = (values: ProjectValues) => {
  if (values.database === "sqlite") return sqliteDotEnv(values);
  return `# Secrets and database settings, read by Bun on the host and by Docker Compose.
# Keep this file out of git.
ADMIN_SECRET=${values.adminSecret}
JWT_SECRET=${values.jwtSecret}
DB_HOST=localhost
DB_PORT=${values.dbPort}
DB_USER=${ENGINES[values.database].user}
DB_PASSWORD=${values.dbPassword}
DB_NAME=${values.dbName}
${rabbitmqEnv(values)}${aiEnv(values)}${redisEnv(values)}${dataToolsEnv(values)}`;
};

const GITIGNORE = `node_modules
.env
`;

// .graphoria holds the schemas `bun run dev` prints.
const GITIGNORE_FRONTEND = `${GITIGNORE}.graphoria
`;

// The database file and the journals SQLite writes beside it.
const SQLITE_FILES = `*.db
*.db-*
`;

const gitignore = ({ database, frontend }: ProjectValues) =>
  `${frontend ? GITIGNORE_FRONTEND : GITIGNORE}${database === "sqlite" ? SQLITE_FILES : ""}`;

const dockerignore = ({ database }: ProjectValues) =>
  `${DOCKERIGNORE}${database === "sqlite" ? SQLITE_FILES : ""}`;

// The Compose volume mounts at /app/data, and the runtime user writes the
// database file there.
const SQLITE_DATA_DIR = `RUN mkdir -p data && chown bun:bun data
`;

const dockerfile = (
  { database }: ProjectValues,
  { bun }: Versions,
) => `# Install stage: bun install and its cache stay here.
FROM oven/bun:${bun}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Final stage: the locked dependencies and the sources, run as the image's non-root \`bun\` user.
FROM oven/bun:${bun}-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
${database === "sqlite" ? SQLITE_DATA_DIR : ""}ENV NODE_ENV=production
USER bun
EXPOSE 3000
# The image has no curl, so Bun makes the request.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \\
  CMD ["bun", "-e", "fetch(\`http://127.0.0.1:\${process.env.PORT ?? 3000}\${process.env.PREFIX ?? ''}/health/live\`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Replaces the base image's entrypoint script: run the project directly.
ENTRYPOINT ["bun", "index.ts"]
`;

const DOCKERIGNORE = `# The image installs its own dependencies from bun.lock.
node_modules
# Secrets come from Compose, never from a layer: Bun loads .env from the working directory.
.env
.env.*
*.md
`;

const PG_SERVICE = `  db:
    image: ${ENGINES.pg.image}
    shm_size: 128mb
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_NAME}
    ports:
      - "\${DB_PORT}:${ENGINES.pg.port}"
    volumes:
      - db-data:${ENGINES.pg.data}
      - ./seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro
    # Over TCP: while the seed runs, Postgres listens on its unix socket only.
    healthcheck:
      test: ["CMD-SHELL", 'pg_isready -h 127.0.0.1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"']
      interval: 5s
      timeout: 5s
      retries: 10
`;

const MYSQL_SERVICE = `  db:
    image: ${ENGINES.mysql.image}
    environment:
      MYSQL_ROOT_PASSWORD: \${DB_PASSWORD}
      MYSQL_DATABASE: \${DB_NAME}
    ports:
      - "\${DB_PORT}:${ENGINES.mysql.port}"
    volumes:
      - db-data:${ENGINES.mysql.data}
      - ./seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro
    # Over TCP: while the seed runs, the temporary server has networking off.
    healthcheck:
      test: ["CMD-SHELL", 'mysqladmin ping -h 127.0.0.1 -uroot -p"$$MYSQL_ROOT_PASSWORD" --silent']
      interval: 5s
      timeout: 5s
      retries: 20
`;

const MSSQL_SERVICES = `  db:
    image: ${ENGINES.mssql.image}
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: \${DB_PASSWORD}
      MSSQL_PID: Developer
    ports:
      - "\${DB_PORT}:${ENGINES.mssql.port}"
    volumes:
      - db-data:${ENGINES.mssql.data}
    healthcheck:
      test:
        [
          "CMD-SHELL",
          '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$$MSSQL_SA_PASSWORD" -C -N -Q "SELECT 1" -b -o /dev/null',
        ]
      interval: 5s
      timeout: 10s
      retries: 30
      start_period: 30s

  # SQL Server cannot create a database from its environment, so this one-shot
  # container creates it and runs the seed, then exits. It runs on every \`up\`,
  # so seed.sql only creates what is missing.
  db-init:
    image: ${ENGINES.mssql.image}
    depends_on:
      db:
        condition: service_healthy
    environment:
      MSSQL_SA_PASSWORD: \${DB_PASSWORD}
    volumes:
      - ./seed.sql:/seed.sql:ro
    entrypoint:
      - /bin/sh
      - -c
      - >-
        /opt/mssql-tools18/bin/sqlcmd -S db -U sa -P "$$MSSQL_SA_PASSWORD" -C -N -b
        -Q "IF DB_ID('\${DB_NAME}') IS NULL CREATE DATABASE [\${DB_NAME}]" &&
        /opt/mssql-tools18/bin/sqlcmd -S db -U sa -P "$$MSSQL_SA_PASSWORD" -C -N -b
        -d \${DB_NAME} -i /seed.sql
`;

const DB_SERVICES: Record<ServerEngine, string> = {
  pg: PG_SERVICE,
  mysql: MYSQL_SERVICE,
  mssql: MSSQL_SERVICES,
};

const RABBITMQ_SERVICE = `  rabbitmq:
    image: rabbitmq:4-management
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_USER}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_PASSWORD}
    ports:
      - "\${RABBITMQ_PORT}:5672"
      - "\${RABBITMQ_MANAGEMENT_PORT}:15672"
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_port_connectivity"]
      interval: 5s
      timeout: 10s
      retries: 12
      start_period: 20s
`;

const REDIS_SERVICE = `  redis:
    image: redis:8
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
`;

// dbgate reads one connection per `_<id>` suffix; `CONNECTIONS` lists the ids.
// It listens on 3000 inside its container, published on DBGATE_PORT.
const DBGATE_SERVICE = (database: ServerEngine) => `  dbgate:
    image: dbgate/dbgate
    restart: always
    ports:
      - "\${DBGATE_PORT}:3000"
    volumes:
      - dbgate-data:/root/.dbgate
    environment:
      CONNECTIONS: db
      LABEL_db: ${ENGINES[database].label}
      ENGINE_db: ${DBGATE_ENGINES[database]}
      SERVER_db: db
      PORT_db: "${ENGINES[database].port}"
      USER_db: \${DB_USER}
      PASSWORD_db: \${DB_PASSWORD}
    depends_on:
      db:
        condition: service_healthy
`;

// No server to point at: dbgate opens the file Graphoria seeds, so it shares
// the volume and waits for the app to create it.
const DBGATE_SQLITE_SERVICE = (dbName: string) => `  dbgate:
    image: dbgate/dbgate
    restart: always
    ports:
      - "\${DBGATE_PORT}:3000"
    volumes:
      - dbgate-data:/root/.dbgate
      - db-data:/app/data
    environment:
      CONNECTIONS: db
      LABEL_db: SQLite
      ENGINE_db: sqlite@dbgate-plugin-sqlite
      FILE_db: /app/data/${dbName}.db
    depends_on:
      graphoria:
        condition: service_healthy
`;

// REDIS_HOSTS is `label:host:port`; the seed Redis has no password.
const REDIS_COMMANDER_SERVICE = `  redis-commander:
    image: rediscommander/redis-commander:latest
    restart: always
    ports:
      - "\${REDIS_COMMANDER_PORT}:8081"
    environment:
      REDIS_HOSTS: local:redis:6379
    depends_on:
      redis:
        condition: service_healthy
`;

const sqliteCompose = ({
  name,
  dbName,
  rabbitmq,
  redis,
  dataTools,
}: ProjectValues) => `# ${name}: SQLite and Graphoria, built from this directory.
#
#   docker compose up -d --build
#
# Then open http://localhost:3000/graphiql. Secrets come from .env. The
# database file lives in the db-data volume; \`docker compose down -v\` deletes it.
services:
${rabbitmq ? RABBITMQ_SERVICE : ""}${redis ? REDIS_SERVICE : ""}${dataTools ? DBGATE_SQLITE_SERVICE(dbName) : ""}${dataTools && redis ? REDIS_COMMANDER_SERVICE : ""}  graphoria:
    build: .
    # Bun as PID 1 ignores SIGTERM; the init forwards it, so \`stop\` is immediate.
    init: true
    restart: on-failure
    env_file: .env
    environment:
      # On the volume, not in the image: the file outlives a rebuild.
      DB_FILE: data/${dbName}.db${rabbitmq ? `\n      RABBITMQ_HOST: rabbitmq\n      RABBITMQ_PORT: "5672"` : ""}${redis ? `\n      REDIS_URL: redis://redis:6379` : ""}
    ports:
      - "3000:3000"
    volumes:
      - db-data:/app/data${rabbitmq || redis ? `\n    depends_on:${rabbitmq ? `\n      rabbitmq:\n        condition: service_healthy` : ""}${redis ? `\n      redis:\n        condition: service_healthy` : ""}` : ""}

volumes:
  db-data:
${rabbitmq ? "  rabbitmq-data:\n" : ""}${redis ? "  redis-data:\n" : ""}${dataTools ? "  dbgate-data:\n" : ""}`;

const dockerCompose = (values: ProjectValues) => {
  if (values.database === "sqlite") return sqliteCompose(values);
  const { name, database, rabbitmq, redis, dataTools } = values;
  const engine = ENGINES[database];
  const dependency =
    database === "mssql"
      ? `      db-init:
        condition: service_completed_successfully`
      : `      db:
        condition: service_healthy`;
  return `# ${name}: ${engine.label} and Graphoria, built from this directory.
#
#   docker compose up -d --build
#
# Then open http://localhost:3000/graphiql. Credentials come from .env. The
# database lives in the db-data volume; \`docker compose down -v\` deletes it.
services:
${DB_SERVICES[database]}${rabbitmq ? RABBITMQ_SERVICE : ""}${redis ? REDIS_SERVICE : ""}${dataTools ? DBGATE_SERVICE(database) : ""}${dataTools && redis ? REDIS_COMMANDER_SERVICE : ""}  graphoria:
    build: .
    # Bun as PID 1 ignores SIGTERM; the init forwards it, so \`stop\` is immediate.
    init: true
    restart: on-failure
    env_file: .env
    environment:
      # Inside Compose the database is the \`db\` service on its own port.
      DB_HOST: db
      DB_PORT: "${engine.port}"${rabbitmq ? `\n      RABBITMQ_HOST: rabbitmq\n      RABBITMQ_PORT: "5672"` : ""}${redis ? `\n      REDIS_URL: redis://redis:6379` : ""}
    ports:
      - "3000:3000"
    # Graphoria connects once at boot, with no retry.
    depends_on:
${dependency}${rabbitmq ? `\n      rabbitmq:\n        condition: service_healthy` : ""}${redis ? `\n      redis:\n        condition: service_healthy` : ""}

volumes:
  db-data:
${rabbitmq ? "  rabbitmq-data:\n" : ""}${redis ? "  redis-data:\n" : ""}${dataTools ? "  dbgate-data:\n" : ""}`;
};

const PG_SEED = `-- Runs once, when the Postgres volume is first created. \`docker compose down -v\` resets it.
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  published_year INT NOT NULL,
  author_id INT NOT NULL REFERENCES authors (id)
);

INSERT INTO authors (name) VALUES
  ('Ursula K. Le Guin'),
  ('Italo Calvino'),
  ('Octavia E. Butler');

INSERT INTO books (title, published_year, author_id) VALUES
  ('A Wizard of Earthsea', 1968, 1),
  ('The Left Hand of Darkness', 1969, 1),
  ('Invisible Cities', 1972, 2),
  ('If on a winter''s night a traveler', 1979, 2),
  ('Kindred', 1979, 3),
  ('Parable of the Sower', 1993, 3);
`;

const MYSQL_SEED = `-- Runs once, when the MySQL volume is first created. \`docker compose down -v\` resets it.
CREATE TABLE authors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE books (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  published_year INT NOT NULL,
  author_id INT NOT NULL,
  FOREIGN KEY (author_id) REFERENCES authors (id)
);

INSERT INTO authors (name) VALUES
  ('Ursula K. Le Guin'),
  ('Italo Calvino'),
  ('Octavia E. Butler');

INSERT INTO books (title, published_year, author_id) VALUES
  ('A Wizard of Earthsea', 1968, 1),
  ('The Left Hand of Darkness', 1969, 1),
  ('Invisible Cities', 1972, 2),
  ('If on a winter''s night a traveler', 1979, 2),
  ('Kindred', 1979, 3),
  ('Parable of the Sower', 1993, 3);
`;

const MSSQL_SEED = `-- db-init runs this on every \`docker compose up\`, so it only creates the tables
-- when they are missing. \`docker compose down -v\` resets the database.
IF OBJECT_ID(N'dbo.authors') IS NULL
BEGIN
  CREATE TABLE dbo.authors (
    id INT IDENTITY PRIMARY KEY,
    name NVARCHAR(255) NOT NULL
  );

  CREATE TABLE dbo.books (
    id INT IDENTITY PRIMARY KEY,
    title NVARCHAR(255) NOT NULL,
    published_year INT NOT NULL,
    author_id INT NOT NULL REFERENCES dbo.authors (id)
  );

  INSERT INTO dbo.authors (name) VALUES
    (N'Ursula K. Le Guin'),
    (N'Italo Calvino'),
    (N'Octavia E. Butler');

  INSERT INTO dbo.books (title, published_year, author_id) VALUES
    (N'A Wizard of Earthsea', 1968, 1),
    (N'The Left Hand of Darkness', 1969, 1),
    (N'Invisible Cities', 1972, 2),
    (N'If on a winter''s night a traveler', 1979, 2),
    (N'Kindred', 1979, 3),
    (N'Parable of the Sower', 1993, 3);
END;
`;

const SQLITE_SEED = `-- graphoria.ts runs this on the first boot, while the database file has no
-- authors table. Delete the file (\`docker compose down -v\` in Docker) to reset it.
BEGIN;

CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  published_year INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES authors (id)
);

INSERT INTO authors (name) VALUES
  ('Ursula K. Le Guin'),
  ('Italo Calvino'),
  ('Octavia E. Butler');

INSERT INTO books (title, published_year, author_id) VALUES
  ('A Wizard of Earthsea', 1968, 1),
  ('The Left Hand of Darkness', 1969, 1),
  ('Invisible Cities', 1972, 2),
  ('If on a winter''s night a traveler', 1979, 2),
  ('Kindred', 1979, 3),
  ('Parable of the Sower', 1993, 3);

COMMIT;
`;

const SEEDS: Record<DatabaseType, string> = {
  pg: PG_SEED,
  mysql: MYSQL_SEED,
  mssql: MSSQL_SEED,
  sqlite: SQLITE_SEED,
};

const BUNFIG = `# Bun.serve bundles web/ with Tailwind.
[serve.static]
plugins = ["bun-plugin-tailwind"]
`;

const indexHtml = ({ name }: ProjectValues) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
`;

const frontendTsx = (values: ProjectValues) => {
  if (!values.rabbitmq) {
    return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Client, Provider, cacheExchange, fetchExchange } from "urql";

import { App } from "./App.tsx";

const client = new Client({
  url: "/graphql",
  // Graphoria answers queries over POST; GET /graphql is its websocket.
  preferGetMethod: false,
  exchanges: [cacheExchange, fetchExchange],
});

const app = (
  <StrictMode>
    <Provider value={client}>
      <App />
    </Provider>
  </StrictMode>
);

const root = document.getElementById("root")!;
if (import.meta.hot) {
  // Hot reload keeps one React root across updates.
  (import.meta.hot.data.root ??= createRoot(root)).render(app);
} else {
  createRoot(root).render(app);
}
`;
  }

  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Client, Provider, cacheExchange, fetchExchange } from "urql";
import { subscriptionExchange } from "@urql/core";
import { createClient as createWSClient } from "graphql-ws";

import { App } from "./App.tsx";

// Graphoria upgrades GET /graphql to its websocket; the queued book-added
// events arrive through the events_onBookAdded subscription.
const wsClient = createWSClient({
  url: \`\${location.protocol === "https:" ? "wss" : "ws"}://\${location.host}/graphql\`,
});

const client = new Client({
  url: "/graphql",
  // Graphoria answers queries over POST; GET /graphql is its websocket.
  preferGetMethod: false,
  exchanges: [
    cacheExchange,
    fetchExchange,
    subscriptionExchange({
      forwardSubscription: (request) => ({
        subscribe: (sink) => ({
          unsubscribe: wsClient.subscribe(
            { query: request.query ?? "", variables: request.variables },
            sink,
          ),
        }),
      }),
    }),
  ],
});

const app = (
  <StrictMode>
    <Provider value={client}>
      <App />
    </Provider>
  </StrictMode>
);

const root = document.getElementById("root")!;
if (import.meta.hot) {
  // Hot reload keeps one React root across updates.
  (import.meta.hot.data.root ??= createRoot(root)).render(app);
} else {
  createRoot(root).render(app);
}
`;
};

const appTsx = (values: ProjectValues) => {
  const schema = seedSchema(values);

  if (values.rabbitmq) {
    return `import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useSubscription } from "urql";

import { graphql } from "./graphql.ts";

const AuthorsQuery = graphql(\`
  query Authors {
    ${schema}_authors(orderBy: [{ id: ASC }]) {
      id
      name
      ${schema}_books(orderBy: [{ published_year: ASC }]) {
        id
        title
        published_year
      }
    }
  }
\`);

// A message is an event, not a state: its arrival just re-fetches the list.
const BookAddedSubscription = graphql(\`
  subscription OnBookAdded {
    events_onBookAdded {
      id
      message
    }
  }
\`);

export function App() {
  const [{ data, fetching, error }, reexecute] = useQuery({ query: AuthorsQuery });
  const [subscription] = useSubscription({ query: BookAddedSubscription });

  useEffect(() => {
    if (subscription.data) reexecute({ requestPolicy: "network-only" });
  }, [subscription.data, reexecute]);

  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [authorId, setAuthorId] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await fetch("/rest/add-book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, publishedYear: Number(year), authorId: Number(authorId) }),
    });
    if (!response.ok) return;
    // The list refreshes when the queued book-added event arrives.
    setTitle("");
    setYear("");
  };

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="mb-6 text-3xl font-bold">Authors</h1>
      <form className="mb-8 space-y-2" onSubmit={submit}>
        <input
          className="block w-full rounded border border-gray-300 p-2"
          placeholder="Title"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <input
          className="block w-full rounded border border-gray-300 p-2"
          placeholder="Year"
          required
          type="number"
          value={year}
          onChange={(event) => setYear(event.target.value)}
        />
        <select
          className="block w-full rounded border border-gray-300 p-2"
          required
          value={authorId}
          onChange={(event) => setAuthorId(event.target.value)}
        >
          <option value="">Pick an author…</option>
          {data?.${schema}_authors.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name}
            </option>
          ))}
        </select>
        <button
          className="rounded bg-black px-4 py-2 text-white"
          type="submit"
        >
          Add book
        </button>
      </form>
      {fetching && <p className="text-gray-500">Loading…</p>}
      {error && <p className="text-red-600">{error.message}</p>}
      <ul className="space-y-6">
        {data?.${schema}_authors.map((author) => (
          <li key={author.id}>
            <h2 className="text-xl font-semibold">{author.name}</h2>
            <ul className="mt-2 list-disc pl-6">
              {author.${schema}_books?.map(
                (book) =>
                  book && (
                    <li key={book.id}>
                      {book.title} <span className="text-gray-500">({book.published_year})</span>
                    </li>
                  ),
              )}
            </ul>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  }

  return `import { useQuery } from "urql";

import { graphql } from "./graphql.ts";

const AuthorsQuery = graphql(\`
  query Authors {
    ${schema}_authors(orderBy: [{ id: ASC }]) {
      id
      name
      ${schema}_books(orderBy: [{ published_year: ASC }]) {
        id
        title
        published_year
      }
    }
  }
\`);

export function App() {
  const [{ data, fetching, error }] = useQuery({ query: AuthorsQuery });

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="mb-6 text-3xl font-bold">Authors</h1>
      {fetching && <p className="text-gray-500">Loading…</p>}
      {error && <p className="text-red-600">{error.message}</p>}
      <ul className="space-y-6">
        {data?.${schema}_authors.map((author) => (
          <li key={author.id}>
            <h2 className="text-xl font-semibold">{author.name}</h2>
            <ul className="mt-2 list-disc pl-6">
              {author.${schema}_books?.map(
                (book) =>
                  book && (
                    <li key={book.id}>
                      {book.title} <span className="text-gray-500">({book.published_year})</span>
                    </li>
                  ),
              )}
            </ul>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
};

const GRAPHQL_TS = `import { initGraphQLTada } from "gql.tada";

// \`bun run types\` writes this file from the schema \`bun run dev\` prints.
import type { introspection } from "./graphql-env.d.ts";

export const graphql = initGraphQLTada<{ introspection: introspection }>();
`;

const frontendFiles = (values: ProjectValues): Record<(typeof FRONTEND_FILES)[number], string> => ({
  "bunfig.toml": BUNFIG,
  "web/index.html": indexHtml(values),
  "web/frontend.tsx": frontendTsx(values),
  "web/App.tsx": appTsx(values),
  "web/graphql.ts": GRAPHQL_TS,
  "web/styles.css": `@import "tailwindcss";\n`,
});

export const renderProject = (
  values: ProjectValues,
  versions: Versions,
): Record<string, string> => ({
  "package.json": packageJson(values, versions),
  "tsconfig.json": values.frontend ? TSCONFIG_FRONTEND : TSCONFIG,
  "graphoria.ts": graphoriaConfig(values),
  "index.ts": values.frontend ? INDEX_FRONTEND : INDEX,
  ".env": dotEnv(values),
  ".gitignore": gitignore(values),
  Dockerfile: dockerfile(values, versions),
  ".dockerignore": dockerignore(values),
  "docker-compose.yml": dockerCompose(values),
  "seed.sql": SEEDS[values.database],
  ...(values.frontend && frontendFiles(values)),
});

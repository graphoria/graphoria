import type { DatabaseType } from "../config";

export type InitAnswers = {
  database: DatabaseType;
  dbName: string;
  dbPassword: string;
  dbPort: number;
};

export type ProjectValues = InitAnswers & { name: string; adminSecret: string; jwtSecret: string };

export type Versions = { graphoria: string; bun: string };

type Engine = { label: string; user: string; port: number; image: string; data: string };

export const ENGINES: Record<DatabaseType, Engine> = {
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

const packageJson = ({ name }: ProjectValues, { graphoria }: Versions) =>
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: { dev: "bun --watch index.ts", start: "bun index.ts" },
      dependencies: { "@graphoria/server": `^${graphoria}` },
      devDependencies: { "@types/bun": "latest", typescript: "^6.0.0" },
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

const MYSQL_CONNECTION_OPTIONS = `      // MySQL 8 authenticates with caching_sha2_password, whose RSA key
      // exchange Bun's client refuses over plain TCP unless allowed.
      connectionOptions: { allowPublicKeyRetrieval: true },
`;

const graphoriaConfig = ({
  name,
  database,
}: ProjectValues) => `import type { ConfigurationFn } from "@graphoria/server/config";

// Bun loads these from .env; in Docker Compose they come from the environment.
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(\`\${name} is not set (see .env)\`);
  return value;
};

export default (() => ({
  name: ${JSON.stringify(name)},
  version: "1.0.0",
  databases: [
    {
      name: "main",
      type: "${database}",
      enabled: true,
      connection: {
        host: env("DB_HOST"),
        port: Number(env("DB_PORT")),
        user: env("DB_USER"),
        password: env("DB_PASSWORD"),
        database: env("DB_NAME"),
      },
${database === "mysql" ? MYSQL_CONNECTION_OPTIONS : ""}    },
  ],
})) satisfies ConfigurationFn;
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

const dotEnv = (
  values: ProjectValues,
) => `# Secrets and database settings, read by Bun on the host and by Docker Compose.
# Keep this file out of git.
ADMIN_SECRET=${values.adminSecret}
JWT_SECRET=${values.jwtSecret}
DB_HOST=localhost
DB_PORT=${values.dbPort}
DB_USER=${ENGINES[values.database].user}
DB_PASSWORD=${values.dbPassword}
DB_NAME=${values.dbName}
`;

const GITIGNORE = `node_modules
.env
`;

const dockerfile = ({ bun }: Versions) => `# Install stage: bun install and its cache stay here.
FROM oven/bun:${bun}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Final stage: the locked dependencies and the sources, run as the image's non-root \`bun\` user.
FROM oven/bun:${bun}-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
ENV NODE_ENV=production
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

const DB_SERVICES: Record<DatabaseType, string> = {
  pg: PG_SERVICE,
  mysql: MYSQL_SERVICE,
  mssql: MSSQL_SERVICES,
};

const dockerCompose = ({ name, database }: ProjectValues) => {
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
${DB_SERVICES[database]}
  graphoria:
    build: .
    # Bun as PID 1 ignores SIGTERM; the init forwards it, so \`stop\` is immediate.
    init: true
    restart: on-failure
    env_file: .env
    environment:
      # Inside Compose the database is the \`db\` service on its own port.
      DB_HOST: db
      DB_PORT: "${engine.port}"
    ports:
      - "3000:3000"
    # Graphoria connects once at boot, with no retry.
    depends_on:
${dependency}

volumes:
  db-data:
`;
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

const SEEDS: Record<DatabaseType, string> = { pg: PG_SEED, mysql: MYSQL_SEED, mssql: MSSQL_SEED };

export const renderProject = (
  values: ProjectValues,
  versions: Versions,
): Record<(typeof PROJECT_FILES)[number], string> => ({
  "package.json": packageJson(values, versions),
  "tsconfig.json": TSCONFIG,
  "graphoria.ts": graphoriaConfig(values),
  "index.ts": INDEX,
  ".env": dotEnv(values),
  ".gitignore": GITIGNORE,
  Dockerfile: dockerfile(versions),
  ".dockerignore": DOCKERIGNORE,
  "docker-compose.yml": dockerCompose(values),
  "seed.sql": SEEDS[values.database],
});

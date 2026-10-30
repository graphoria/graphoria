import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DatabaseType } from "../config";

import { genResolverName } from "../databases/transformers/genResolverName";
import { storesInUse } from "../singletons/cache";
import { ConfigurationZod } from "../types/zod/configuration";
import { FRONTEND_FILES, PROJECT_FILES, renderProject, type ProjectValues } from "./initTemplates";

const STARTER = join(import.meta.dir, "../../../../examples/docker-compose-starter");
const PLAYGROUNDS = join(import.meta.dir, "../../../playgrounds/package.json");
// What `@graphoria/server/config` resolves to. A generated config written outside
// the workspace imports this instead: no node_modules above it holds the package.
const CONFIG_SOURCE = join(import.meta.dir, "../config/index.ts");

const values = (database: DatabaseType): ProjectValues => ({
  database,
  name: "my-api",
  dbName: "shop",
  dbPassword: "Pa55word.x",
  dbPort: 15432,
  rabbitmq: false,
  ai: false,
  mcp: false,
  auth: false,
  redis: false,
  dataTools: false,
  frontend: false,
  cron: false,
  rabbitmqPassword: "rabbit-pass",
  adminSecret: "admin-secret-value",
  jwtSecret: "jwt-secret-value",
});

const versions = { graphoria: "0.6.0", bun: "1.4.2" };

// Writes what a generated config loads, into its own directory: graphoria.ts
// imports ./repository, which differs per engine, and both import the config
// helpers from CONFIG_SOURCE. Returns the path of graphoria.ts.
const writeProject = async (
  project: string,
  files: Record<string, string>,
  names = ["graphoria.ts", "repository.ts"],
) => {
  await mkdir(project, { recursive: true });
  for (const name of names) {
    await writeFile(
      join(project, name),
      files[name]!.replaceAll('"@graphoria/server/config"', JSON.stringify(CONFIG_SOURCE)),
    );
  }
  return join(project, "graphoria.ts");
};

const render = (database: DatabaseType) => renderProject(values(database), versions);

const renderWith = (patch: Partial<ProjectValues>, database: DatabaseType = "pg") =>
  renderProject({ ...values(database), ...patch }, versions);

const ENGINES: DatabaseType[] = ["pg", "mysql", "mssql", "sqlite"];
const SERVER_ENGINES: DatabaseType[] = ["pg", "mysql", "mssql"];

const PATHS = [
  ".dockerignore",
  ".env",
  ".gitignore",
  "Dockerfile",
  "docker-compose.yml",
  "graphoria.ts",
  "index.ts",
  "package.json",
  "repository.ts",
  "seed.sql",
  "tsconfig.json",
];

describe("renderProject paths", () => {
  it.each(ENGINES)("renders the same eleven files for %s", (database) => {
    expect(Object.keys(render(database)).sort()).toEqual(PATHS);
  });

  it("lists those files in PROJECT_FILES", () => {
    expect(Array.from<string>(PROJECT_FILES).sort()).toEqual(PATHS);
  });
});

describe("renderProject Docker recipe", () => {
  it("matches the starter's Dockerfile and .dockerignore", async () => {
    const dockerfile = await readFile(join(STARTER, "Dockerfile"), "utf8");
    const dockerignore = await readFile(join(STARTER, ".dockerignore"), "utf8");
    const bun = dockerfile.match(/^FROM oven\/bun:(\S+)-slim/m)?.[1];
    expect(bun).toBeDefined();

    const files = renderProject(values("pg"), { graphoria: "0.6.0", bun: bun! });

    expect(files.Dockerfile).toBe(dockerfile);
    expect(files[".dockerignore"]).toBe(dockerignore);
  });

  it("builds on the Bun version it is given", () => {
    const files = renderProject(values("pg"), { graphoria: "0.6.0", bun: "9.9.9" });
    const froms = files.Dockerfile!.split("\n").filter((line) => line.startsWith("FROM "));

    expect(froms).toEqual(["FROM oven/bun:9.9.9-slim AS deps", "FROM oven/bun:9.9.9-slim"]);
  });
});

describe("renderProject package.json", () => {
  it("depends on the running Graphoria version and TypeScript 6", () => {
    const pkg = JSON.parse(render("pg")["package.json"]!);

    expect(pkg.name).toBe("my-api");
    expect(pkg.dependencies).toEqual({ "@graphoria/server": "^0.6.0" });
    expect(pkg.devDependencies.typescript).toBe("^6.0.0");
    expect(pkg.scripts).toEqual({ dev: "bun --watch index.ts", start: "bun index.ts" });
  });

  it.each([
    [{}, {}],
    [{ rabbitmq: true }, { "@graphoria/queues": "^0.6.0" }],
    [{ ai: true }, { "@graphoria/ai": "^0.6.0" }],
    [{ mcp: true }, { "@graphoria/ai": "^0.6.0" }],
    [{ ai: true, mcp: true }, { "@graphoria/ai": "^0.6.0" }],
    [
      { rabbitmq: true, ai: true },
      { "@graphoria/queues": "^0.6.0", "@graphoria/ai": "^0.6.0" },
    ],
  ] as const)("adds the adapter packages for %j", (patch, expected) => {
    const pkg = JSON.parse(renderWith(patch as Partial<ProjectValues>)["package.json"]!);

    expect(pkg.dependencies).toEqual({ "@graphoria/server": "^0.6.0", ...expected });
  });
});

describe("renderProject .env", () => {
  it.each([
    ["pg", "postgres"],
    ["mysql", "root"],
    ["mssql", "sa"],
  ] as const)("points %s at localhost as %s", (database, user) => {
    const lines = render(database)[".env"]!.split("\n");

    expect(lines).toContain("ADMIN_SECRET=admin-secret-value");
    expect(lines).toContain("JWT_SECRET=jwt-secret-value");
    expect(lines).toContain("DB_HOST=localhost");
    expect(lines).toContain("DB_PORT=15432");
    expect(lines).toContain(`DB_USER=${user}`);
    expect(lines).toContain("DB_PASSWORD=Pa55word.x");
    expect(lines).toContain("DB_NAME=shop");
  });

  it("adds the RabbitMQ settings, with a generated password", () => {
    const lines = renderWith({ rabbitmq: true })[".env"]!.split("\n");

    expect(lines).toContain("RABBITMQ_HOST=localhost");
    expect(lines).toContain("RABBITMQ_PORT=5672");
    expect(lines).toContain("RABBITMQ_MANAGEMENT_PORT=15672");
    expect(lines).toContain("RABBITMQ_USER=graphoria");
    expect(lines).toContain("RABBITMQ_PASSWORD=rabbit-pass");
    expect(lines).toContain("RABBITMQ_VHOST=/");
    expect(render("pg")[".env"]).not.toContain("RABBITMQ_");
  });

  it.each(["pg", "sqlite"] as const)(
    "adds the LLM settings, keeping Ollama on localhost for %s",
    (database) => {
      const lines = renderWith({ ai: true }, database)[".env"]!.split("\n");

      expect(lines).toContain("LLM_PROVIDER=ollama");
      expect(lines).toContain("OLLAMA_HOST=http://localhost:11434");
      expect(render(database)[".env"]).not.toContain("LLM_PROVIDER");
    },
  );

  it.each(["pg", "sqlite"] as const)(
    "adds no settings for the MCP server, which calls no LLM, for %s",
    (database) => {
      expect(renderWith({ mcp: true }, database)[".env"]).toBe(render(database)[".env"]);
    },
  );

  it.each(["pg", "sqlite"] as const)(
    "points the cache, the rate limits and the auth token store at Redis for %s",
    (database) => {
      const lines = renderWith({ redis: true }, database)[".env"]!.split("\n");

      expect(lines).toContain("REDIS_URL=redis://localhost:6379");
      expect(lines).toContain("AUTH_STORE=redis");
      expect(lines).toContain("RATE_LIMIT_STORE=redis");
      expect(lines.some((line) => line.startsWith("CACHE_STORE"))).toBe(false);
      expect(render(database)[".env"]).not.toContain("REDIS_URL");
      expect(render(database)[".env"]).not.toContain("_STORE=");
    },
  );

  it.each(["pg", "sqlite"] as const)("publishes dbgate's port for %s", (database) => {
    const lines = renderWith({ dataTools: true }, database)[".env"]!.split("\n");

    expect(lines).toContain("DBGATE_PORT=9000");
    expect(lines).not.toContain("REDIS_COMMANDER_PORT=8081");
    expect(render(database)[".env"]).not.toContain("DBGATE_PORT");
  });

  it("adds Redis Commander's port only when Redis is present too", () => {
    const lines = renderWith({ dataTools: true, redis: true })[".env"]!.split("\n");

    expect(lines).toContain("DBGATE_PORT=9000");
    expect(lines).toContain("REDIS_COMMANDER_PORT=8081");
  });

  it("adds every feature's settings together without overlap", () => {
    const lines = renderWith({
      rabbitmq: true,
      ai: true,
      redis: true,
      dataTools: true,
    })[".env"]!.split("\n");

    expect(lines).toContain("DB_HOST=localhost");
    expect(lines).toContain("RABBITMQ_HOST=localhost");
    expect(lines).toContain("LLM_PROVIDER=ollama");
    expect(lines).toContain("REDIS_URL=redis://localhost:6379");
    expect(lines).toContain("AUTH_STORE=redis");
    expect(lines).toContain("RATE_LIMIT_STORE=redis");
    expect(lines).toContain("DBGATE_PORT=9000");
    expect(lines).toContain("REDIS_COMMANDER_PORT=8081");
  });
});

describe("renderProject docker-compose.yml", () => {
  type Service = {
    image?: string;
    build?: string;
    init?: boolean;
    env_file?: string;
    environment?: object;
    ports?: string[];
    volumes?: string[];
    healthcheck?: { test: unknown };
    depends_on?: Record<string, { condition: string }>;
  };
  type Compose = {
    services: {
      db: Service;
      graphoria: Service;
      "db-init"?: Service;
      rabbitmq?: Service;
      redis?: Service;
      dbgate?: Service;
      "redis-commander"?: Service;
    };
    volumes: Record<string, unknown>;
  };
  const compose = (database: DatabaseType, patch: Partial<ProjectValues> = {}) =>
    Bun.YAML.parse(renderWith(patch, database)["docker-compose.yml"]!) as Compose;

  it.each([
    {
      database: "pg",
      image: "postgres:18",
      port: 5432,
      data: "db-data:/var/lib/postgresql",
      environment: {
        POSTGRES_USER: "${DB_USER}",
        POSTGRES_PASSWORD: "${DB_PASSWORD}",
        POSTGRES_DB: "${DB_NAME}",
      },
    },
    {
      database: "mysql",
      image: "mysql:8",
      port: 3306,
      data: "db-data:/var/lib/mysql",
      environment: { MYSQL_ROOT_PASSWORD: "${DB_PASSWORD}", MYSQL_DATABASE: "${DB_NAME}" },
    },
    {
      database: "mssql",
      image: "mcr.microsoft.com/mssql/server:2022-latest",
      port: 1433,
      data: "db-data:/var/opt/mssql",
      environment: {
        ACCEPT_EULA: "Y",
        MSSQL_SA_PASSWORD: "${DB_PASSWORD}",
        MSSQL_PID: "Developer",
      },
    },
  ] as const)("runs $database from .env", ({ database, image, port, data, environment }) => {
    const { services, volumes } = compose(database);

    expect(services.db.image).toBe(image);
    expect(services.db.environment).toEqual(environment);
    expect(services.db.ports).toEqual([`\${DB_PORT}:${port}`]);
    expect(services.db.volumes).toContain(data);
    expect(services.db.healthcheck?.test).toBeDefined();
    expect(Object.keys(volumes)).toEqual(["db-data"]);

    expect(services.graphoria.build).toBe(".");
    expect(services.graphoria.init).toBe(true);
    expect(services.graphoria.env_file).toBe(".env");
    expect(services.graphoria.environment).toEqual({ DB_HOST: "db", DB_PORT: String(port) });
    expect(services.graphoria.ports).toEqual(["3000:3000"]);
  });

  it.each(["pg", "mysql"] as const)("seeds %s from the image's init scripts", (database) => {
    const { services } = compose(database);

    expect(Object.keys(services).sort()).toEqual(["db", "graphoria"]);
    expect(services.db.volumes).toContain("./seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro");
    expect(services.graphoria.depends_on).toEqual({ db: { condition: "service_healthy" } });
  });

  it("creates and seeds the SQL Server database in a one-shot db-init", () => {
    const { services } = compose("mssql");

    expect(Object.keys(services).sort()).toEqual(["db", "db-init", "graphoria"]);
    expect(services["db-init"]?.image).toBe(services.db.image!);
    expect(services["db-init"]?.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(services["db-init"]?.volumes).toEqual(["./seed.sql:/seed.sql:ro"]);
    expect(services.graphoria.depends_on).toEqual({
      "db-init": { condition: "service_completed_successfully" },
    });
  });

  it.each(["pg", "sqlite"] as const)(
    "runs RabbitMQ from .env and points Graphoria at it (%s)",
    (database) => {
      const { services, volumes } = compose(database, { rabbitmq: true });

      expect(services.rabbitmq!.image).toBe("rabbitmq:4-management");
      expect(services.rabbitmq!.environment).toEqual({
        RABBITMQ_DEFAULT_USER: "${RABBITMQ_USER}",
        RABBITMQ_DEFAULT_PASS: "${RABBITMQ_PASSWORD}",
      });
      expect(services.rabbitmq!.ports).toEqual([
        "${RABBITMQ_PORT}:5672",
        "${RABBITMQ_MANAGEMENT_PORT}:15672",
      ]);
      expect(services.rabbitmq!.volumes).toContain("rabbitmq-data:/var/lib/rabbitmq");
      expect(services.rabbitmq!.healthcheck?.test).toBeDefined();
      expect(services.graphoria!.environment).toMatchObject({
        RABBITMQ_HOST: "rabbitmq",
        RABBITMQ_PORT: "5672",
      });
      expect(services.graphoria!.depends_on).toMatchObject({
        rabbitmq: { condition: "service_healthy" },
      });
      expect(Object.keys(volumes).sort()).toEqual(["db-data", "rabbitmq-data"]);
    },
  );

  it("leaves the broker out by default", () => {
    expect(compose("pg").services.rabbitmq).toBeUndefined();
  });

  it.each(["pg", "sqlite"] as const)(
    "runs Redis from .env and points Graphoria at it (%s)",
    (database) => {
      const { services, volumes } = compose(database, { redis: true });

      expect(services.redis!.image).toBe("redis:8");
      expect(services.redis!.ports).toEqual(["6379:6379"]);
      expect(services.redis!.volumes).toContain("redis-data:/data");
      expect(services.redis!.healthcheck?.test).toBeDefined();
      expect(services.graphoria!.environment).toMatchObject({
        REDIS_URL: "redis://redis:6379",
      });
      expect(services.graphoria!.depends_on).toMatchObject({
        redis: { condition: "service_healthy" },
      });
      expect(Object.keys(volumes).sort()).toEqual(["db-data", "redis-data"]);
    },
  );

  it("leaves Redis out by default", () => {
    expect(compose("pg").services.redis).toBeUndefined();
  });

  it.each(["pg", "sqlite"] as const)(
    "adds no service for the MCP server, which Graphoria serves itself (%s)",
    (database) => {
      expect(renderWith({ mcp: true }, database)["docker-compose.yml"]).toBe(
        render(database)["docker-compose.yml"],
      );
    },
  );

  it.each([
    { database: "pg" as const, engine: "postgres@dbgate-plugin-postgres", port: "5432" },
    { database: "mysql" as const, engine: "mysql@dbgate-plugin-mysql", port: "3306" },
    { database: "mssql" as const, engine: "mssql@dbgate-plugin-mssql", port: "1433" },
  ])("points dbgate at the $database service", ({ database, engine, port }) => {
    const { services, volumes } = compose(database, { dataTools: true });

    expect(services.dbgate!.image).toBe("dbgate/dbgate");
    expect(services.dbgate!.ports).toEqual(["${DBGATE_PORT}:3000"]);
    expect(services.dbgate!.volumes).toContain("dbgate-data:/root/.dbgate");
    expect(services.dbgate!.environment).toEqual({
      CONNECTIONS: "db",
      LABEL_db: expect.any(String),
      ENGINE_db: engine,
      SERVER_db: "db",
      PORT_db: port,
      USER_db: "${DB_USER}",
      PASSWORD_db: "${DB_PASSWORD}",
    });
    expect(services.dbgate!.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(Object.keys(volumes).sort()).toEqual(["db-data", "dbgate-data"]);
  });

  it("opens the SQLite file dbgate shares with Graphoria", () => {
    const { services, volumes } = compose("sqlite", { dataTools: true });

    expect(services.dbgate!.environment).toEqual({
      CONNECTIONS: "db",
      LABEL_db: "SQLite",
      ENGINE_db: "sqlite@dbgate-plugin-sqlite",
      FILE_db: "/app/data/shop.db",
    });
    expect(services.dbgate!.volumes).toContain("db-data:/app/data");
    expect(services.dbgate!.depends_on).toEqual({ graphoria: { condition: "service_healthy" } });
    expect(Object.keys(volumes).sort()).toEqual(["db-data", "dbgate-data"]);
  });

  it("adds Redis Commander only alongside Redis", () => {
    const withRedis = compose("pg", { dataTools: true, redis: true }).services["redis-commander"];
    expect(withRedis!.image).toBe("rediscommander/redis-commander:latest");
    expect(withRedis!.ports).toEqual(["${REDIS_COMMANDER_PORT}:8081"]);
    expect(withRedis!.environment).toEqual({ REDIS_HOSTS: "local:redis:6379" });
    expect(withRedis!.depends_on).toEqual({ redis: { condition: "service_healthy" } });

    expect(compose("pg", { dataTools: true }).services["redis-commander"]).toBeUndefined();
  });

  it("leaves the data tools out by default", () => {
    expect(compose("pg").services.dbgate).toBeUndefined();
    expect(compose("pg").services["redis-commander"]).toBeUndefined();
    expect(Object.keys(compose("pg").volumes)).toEqual(["db-data"]);
  });

  it.each(["pg", "sqlite"] as const)(
    "runs RabbitMQ and Redis together and waits on both (%s)",
    (database) => {
      const { services, volumes } = compose(database, { rabbitmq: true, redis: true });

      expect(services.rabbitmq!.image).toBe("rabbitmq:4-management");
      expect(services.redis!.image).toBe("redis:8");
      expect(services.graphoria!.environment).toMatchObject({
        RABBITMQ_HOST: "rabbitmq",
        RABBITMQ_PORT: "5672",
        REDIS_URL: "redis://redis:6379",
      });
      expect(services.graphoria!.depends_on).toMatchObject({
        rabbitmq: { condition: "service_healthy" },
        redis: { condition: "service_healthy" },
      });
      expect(Object.keys(volumes).sort()).toEqual(["db-data", "rabbitmq-data", "redis-data"]);
    },
  );

  it.each(ENGINES)("sets each %s service apart with a blank line", (database) => {
    for (const patch of [{}, { rabbitmq: true, redis: true, dataTools: true }]) {
      // A service's last, indented line followed straight by the next service.
      expect(renderWith(patch, database)["docker-compose.yml"]).not.toMatch(
        /\n {4}.*\n {2}[a-z-]+:\n/,
      );
    }
  });

  // The line above a key: these templates comment a setting right above it.
  const commentAbove = (yaml: string, key: string) => {
    const lines = yaml.split("\n");
    return lines[lines.indexOf(key) - 1];
  };

  it.each(ENGINES)(
    "comments the init as the starter does, without --frontend (%s)",
    async (database) => {
      const starter = await readFile(join(STARTER, "docker-compose.yml"), "utf8");
      const yaml = renderWith({}, database)["docker-compose.yml"]!;

      expect(commentAbove(yaml, "    init: true")).toBe(commentAbove(starter, "    init: true"));
      expect(yaml).not.toContain("ignores SIGTERM");
    },
  );

  it.each(ENGINES)("says the init covers the boot with --frontend (%s)", (database) => {
    const yaml = renderWith({ frontend: true }, database)["docker-compose.yml"]!;

    expect(commentAbove(yaml, "    init: true")).toBe(
      "    # Keep it: until index.ts reaches handleSignals, Bun as PID 1 ignores SIGTERM.",
    );
  });

  it.each(ENGINES)("never says the boot has no retry (%s)", (database) => {
    for (const frontend of [false, true]) {
      expect(renderWith({ frontend }, database)["docker-compose.yml"]).not.toContain("no retry");
    }
  });

  it.each(["pg", "mysql", "mssql"] as const)(
    "says the boot would retry the database (%s)",
    (database) => {
      expect(renderWith({}, database)["docker-compose.yml"]).toContain(
        "    # Start once the database is ready. Boot would otherwise retry it for up to 60 s.\n    depends_on:\n",
      );
    },
  );
});

describe("renderProject graphoria.ts", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "graphoria-init-templates-"));
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  afterEach(() => {
    for (const key of [
      "DB_HOST",
      "DB_PORT",
      "DB_USER",
      "DB_PASSWORD",
      "DB_NAME",
      "RABBITMQ_HOST",
      "RABBITMQ_PORT",
      "RABBITMQ_USER",
      "RABBITMQ_PASSWORD",
      "RABBITMQ_VHOST",
      "REDIS_URL",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  let seq = 0;
  const load = async (database: DatabaseType, patch: Partial<ProjectValues> = {}) => {
    const path = await writeProject(join(dir, `${database}-${seq++}`), renderWith(patch, database));
    const module = await import(path);
    return module.default as (helpers: object) => unknown;
  };

  const setEnv = () => {
    process.env.DB_HOST = "db.internal";
    process.env.DB_PORT = "15432";
    process.env.DB_USER = "someone";
    process.env.DB_PASSWORD = "Pa55word.x";
    process.env.DB_NAME = "shop";
    process.env.REDIS_URL = "redis://cache.internal:6379";
  };

  const setRabbitEnv = () => {
    process.env.RABBITMQ_HOST = "rabbit.internal";
    process.env.RABBITMQ_PORT = "5672";
    process.env.RABBITMQ_USER = "graphoria";
    process.env.RABBITMQ_PASSWORD = "rabbit-pass";
    process.env.RABBITMQ_VHOST = "/";
  };

  it.each(SERVER_ENGINES)("reads the %s connection from the environment", async (database) => {
    setEnv();
    const configuration = ConfigurationZod.parse((await load(database))({}));

    expect(configuration.name).toBe("my-api");
    expect(configuration.databases).toHaveLength(1);
    expect(configuration.databases![0]!.type).toBe(database);
    expect(configuration.databases![0]!.connection).toEqual({
      host: "db.internal",
      port: 15432,
      user: "someone",
      password: "Pa55word.x",
      database: "shop",
    });
  });

  it("lets MySQL retrieve the server's public key", async () => {
    setEnv();
    const configuration = ConfigurationZod.parse((await load("mysql"))({}));

    expect(configuration.databases![0]!.connectionOptions).toMatchObject({
      allowPublicKeyRetrieval: true,
    });
  });

  it.each(["pg", "mssql"] as const)("sets no connection options for %s", async (database) => {
    setEnv();
    const configuration = ConfigurationZod.parse((await load(database))({}));

    expect(configuration.databases![0]!.connectionOptions).toBeUndefined();
  });

  it("names a missing variable", async () => {
    setEnv();
    delete process.env.DB_PASSWORD;
    const configure = await load("pg");

    expect(() => configure({})).toThrow("DB_PASSWORD is not set");
  });

  it("declares a RabbitMQ queue with a publisher and a subscriber", async () => {
    setEnv();
    setRabbitEnv();
    const { queues } = ConfigurationZod.parse((await load("pg", { rabbitmq: true }))({}));
    const entry = queues![0]!;

    expect(entry).toMatchObject({ type: "rabbitmq", name: "events" });
    expect(entry.connection).toEqual({
      hostname: "rabbit.internal",
      port: 5672,
      username: "graphoria",
      password: "rabbit-pass",
      vhost: "/",
    });
    expect(entry.exchanges).toEqual([
      {
        name: "books",
        type: "topic",
        options: { durable: true, autoDelete: false },
        publishers: [
          {
            name: "bookAdded",
            resolverName: "events_bookAdded",
            routingKey: "book.added",
            options: { persistent: true },
          },
        ],
      },
    ]);
    expect(entry.queues).toHaveLength(1);
    expect(entry.queues![0]).toMatchObject({
      name: "onBookAdded",
      bindings: [{ exchange: "books", pattern: "book.added" }],
    });
    expect(typeof entry.queues![0]!.handler).toBe("function");
  });

  it("enables the AI agent only when asked", async () => {
    setEnv();

    expect(ConfigurationZod.parse((await load("pg", { ai: true }))({})).ai.enabled).toBe(true);
    expect(ConfigurationZod.parse((await load("pg", {}))({})).ai.enabled).toBe(false);
  });

  it.each([
    [{ mcp: true }, false, true],
    [{ ai: true, mcp: true }, true, true],
    [{ ai: true }, true, false],
    [{}, false, false],
  ])("enables the MCP server apart from the agent for %j", async (patch, agent, mcp) => {
    setEnv();
    const { ai } = ConfigurationZod.parse((await load("pg", patch))({}));

    expect(ai.enabled).toBe(agent);
    expect(ai.mcp.enabled).toBe(mcp);
  });

  it("declares the redis store behind the in-process one", async () => {
    setEnv();

    expect(ConfigurationZod.parse((await load("pg", { redis: true }))({})).caches).toEqual({
      default: ["memory", "redis"],
      stores: { redis: { type: "redis", url: "redis://cache.internal:6379" } },
    });
    expect(ConfigurationZod.parse((await load("pg"))({})).caches).toEqual({
      default: ["memory"],
      stores: {},
    });
  });

  it("caches GET /rest/books in the redis store with --redis", async () => {
    setEnv();
    const configuration = ConfigurationZod.parse((await load("pg", { redis: true }))({}));

    expect(configuration.operations.books).toMatchObject({
      rest: { path: "/books", method: "GET" },
      cache: { ttl: 10_000, max: 100 },
    });
    expect(storesInUse(configuration, undefined, undefined)).toEqual(["redis"]);
  });

  it("schedules the books report every minute with --cron", async () => {
    setEnv();
    const { cron } = ConfigurationZod.parse((await load("pg", { cron: true }))({}));

    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({
      name: "booksReport",
      pattern: "* * * * *",
      protect: true,
      query: "query { public_books { id } }",
    });
    expect(ConfigurationZod.parse((await load("pg"))({})).cron).toEqual([]);
  });

  it.each([
    {
      what: "books",
      patch: { cron: true },
      data: { public_books: [{ id: 1 }, { id: 2 }] },
      line: ["[booksReport] books:", 2],
    },
    {
      what: "books and drafts with --auth",
      patch: { cron: true, auth: true },
      data: { public_books: [{ status: "published" }, { status: "draft" }, { status: "draft" }] },
      line: ["[booksReport] books:", 3, "drafts:", 2],
    },
  ])("logs the number of $what from the report's answer", async ({ patch, data, line }) => {
    setEnv();
    const [job] = ConfigurationZod.parse((await load("pg", patch))({})).cron;
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      await job!.onTick!({} as never, {} as never, { data });
      expect(log).toHaveBeenCalledWith(...line);
    } finally {
      log.mockRestore();
    }
  });

  it("selects each book's status for the report with --auth", async () => {
    setEnv();
    const [job] = ConfigurationZod.parse((await load("pg", { cron: true, auth: true }))({})).cron;

    expect(job!.query).toBe("query { public_books { status } }");
  });

  it("fails the tick with the query's errors when it answered no data", async () => {
    setEnv();
    const [job] = ConfigurationZod.parse((await load("pg", { cron: true }))({})).cron;
    const errors = [{ message: "connection refused" }];

    expect(() => job!.onTick!({} as never, {} as never, { data: null, errors })).toThrow(
      'booksReport: [{"message":"connection refused"}]',
    );
  });

  it.each(SERVER_ENGINES)("adds the add-book operation to the %s scaffold", async (database) => {
    setEnv();
    const configuration = ConfigurationZod.parse((await load(database))({}));

    expect(Object.keys(configuration.operations)).toEqual(["addBook"]);
    expect(configuration.operations.addBook!.rest).toMatchObject({
      path: "/add-book",
      method: "POST",
    });
  });

  it.each([
    { rabbitmq: true },
    { ai: true },
    { mcp: true },
    { rabbitmq: true, ai: true },
    { ai: true, mcp: true },
    { redis: true },
    { cron: true },
    { rabbitmq: true, ai: true, mcp: true, redis: true, cron: true },
  ])("still parses with %j", async (patch) => {
    setEnv();
    setRabbitEnv();

    const configure = await load("pg", patch);
    expect(() => ConfigurationZod.parse(configure({}))).not.toThrow();
  });

  it.each(ENGINES)("sets the %s config's blocks apart with a blank line", (database) => {
    const config = render(database)["graphoria.ts"]!;

    expect(config).toContain("};\n\n// The body of POST /rest/add-book");
    expect(config).toContain("});\n\nexport default");
  });
});

describe("renderProject seed.sql", () => {
  it.each(ENGINES)("creates authors and books for %s", (database) => {
    const seed = render(database)["seed.sql"]!;

    expect(seed).toMatch(/CREATE TABLE (dbo\.)?authors/);
    expect(seed).toMatch(/CREATE TABLE (dbo\.)?books/);
    expect(seed).toContain("'Ursula K. Le Guin'");
  });

  it("guards the SQL Server seed, which db-init reruns on every up", () => {
    const seed = render("mssql")["seed.sql"]!;
    const statements = seed.replace(/^--.*\n/gm, "");

    expect(statements.trimStart()).toStartWith("IF OBJECT_ID(N'dbo.authors') IS NULL");
  });
});

describe("renderProject with --auth", () => {
  // The seed's schema, which prefixes its field names: a MySQL schema is its database.
  const TABLES = { pg: "public", mysql: "shop", mssql: "dbo", sqlite: "main" } as const;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "graphoria-init-auth-"));
    process.env.DB_HOST = "db.internal";
    process.env.DB_PORT = "15432";
    process.env.DB_USER = "someone";
    process.env.DB_PASSWORD = "Pa55word.x";
    process.env.DB_NAME = "shop";
    process.env.DB_FILE = join(dir, "unused.db");
    process.env.RABBITMQ_HOST = "rabbit.internal";
    process.env.RABBITMQ_PORT = "5672";
    process.env.RABBITMQ_USER = "graphoria";
    process.env.RABBITMQ_PASSWORD = "rabbit-pass";
    process.env.RABBITMQ_VHOST = "/";
    process.env.REDIS_URL = "redis://cache.internal:6379";
  });

  afterAll(async () => {
    for (const key of [
      "DB_HOST",
      "DB_PORT",
      "DB_USER",
      "DB_PASSWORD",
      "DB_NAME",
      "DB_FILE",
      "RABBITMQ_HOST",
      "RABBITMQ_PORT",
      "RABBITMQ_USER",
      "RABBITMQ_PASSWORD",
      "RABBITMQ_VHOST",
      "REDIS_URL",
    ]) {
      delete process.env[key];
    }
    await rm(dir, { recursive: true, force: true });
  });

  let seq = 0;
  const parse = async (database: DatabaseType, patch: Partial<ProjectValues> = {}) => {
    const path = await writeProject(
      join(dir, `${database}-${seq++}`),
      renderWith({ auth: true, ...patch }, database),
    );
    return ConfigurationZod.parse(((await import(path)).default as (h: object) => unknown)({}));
  };

  it.each(ENGINES)("turns auth on for %s, creating the user table itself", async (database) => {
    const { auth } = await parse(database);

    expect(auth.enabled).toBe(true);
    expect(auth.database).toBe("main");
    expect(auth.autoCreateTables).toBe(true);
    expect(auth.schema).toBe(database === "sqlite" ? "main" : "auth");
    expect(Object.keys(auth.permissions)).toEqual(["anonymous", "reader", "editor"]);
  });

  it.each(ENGINES)("grants the three %s tiers", async (database) => {
    const table = (name: string) => `${TABLES[database]}_${name}`;
    const { auth } = await parse(database);

    expect(auth.permissions.anonymous).toMatchObject({
      tables: { [table("authors")]: { columns: "ALL" } },
      operations: [],
      queues: [],
      ai: false,
    });
    expect(auth.permissions.reader).toMatchObject({
      tables: {
        [table("authors")]: { columns: "ALL" },
        [table("books")]: { columns: "ALL", filter: { status: { eq: "published" } } },
      },
      operations: [],
      queues: [],
      ai: false,
    });
    expect(auth.permissions.editor).toMatchObject({
      tables: { [table("authors")]: { columns: "ALL" }, [table("books")]: { columns: "ALL" } },
      operations: ["addBook", "publishBook"],
      queues: [],
      ai: false,
    });
    // toMatchObject reads each table's grant as a subset: these pin that only
    // the reader's books carry a filter.
    expect(auth.permissions.anonymous!.tables).toEqual({ [table("authors")]: { columns: "ALL" } });
    expect(auth.permissions.reader!.tables).toEqual({
      [table("authors")]: { columns: "ALL" },
      [table("books")]: { columns: "ALL", filter: { status: { eq: "published" } } },
    });
    expect(auth.permissions.editor!.tables).toEqual({
      [table("authors")]: { columns: "ALL" },
      [table("books")]: { columns: "ALL" },
    });
  });

  it.each([
    [
      { redis: true },
      { operations: ["books"] },
      { operations: ["books", "addBook", "publishBook"] },
    ],
    [{ ai: true }, { ai: true }, { ai: true }],
    [
      { rabbitmq: true },
      { queues: { events: { publishers: [], subscribers: ["onBookPublished"] } } },
      { queues: ["events"] },
    ],
  ])("extends the roles for %j", async (patch, reader, editor) => {
    const { auth } = await parse("pg", patch);

    expect(auth.permissions.reader).toMatchObject(reader);
    expect(auth.permissions.editor).toMatchObject(editor);
    expect(auth.permissions.anonymous).toMatchObject({ operations: [], queues: [], ai: false });
  });

  it("replaces the frontend's anonymous grant", async () => {
    const config = renderWith({ auth: true, frontend: true })["graphoria.ts"]!;
    const { auth } = await parse("pg", { frontend: true });

    expect(config).not.toContain("The frontend has no login");
    expect(Object.keys(auth.permissions.anonymous!.tables)).toEqual(["public_authors"]);
    expect(auth.permissions.anonymous).toMatchObject({ operations: [], queues: [], ai: false });
  });

  it.each(ENGINES)(
    "adds publishBook to the %s scaffold, answering a row or null",
    async (database) => {
      const { operations } = await parse(database);

      expect(Object.keys(operations)).toEqual(["addBook", "publishBook"]);
      expect(operations.publishBook!.rest).toMatchObject({ path: "/publish-book", method: "POST" });
      expect(operations.publishBook!.output!.safeParse(null).success).toBe(true);
      expect(
        operations.publishBook!.output!.safeParse({
          id: 7,
          title: "Kindred",
          publishedYear: 1979,
          authorId: 3,
        }).success,
      ).toBe(true);
    },
  );

  it("publishes through the repository", async () => {
    const { operations } = await parse("pg");
    const published: number[] = [];
    const repository = {
      main: {
        books: {
          publish: async (id: number) => {
            published.push(id);
            return null;
          },
        },
      },
    };

    expect(await operations.publishBook!.handler!({ repository } as never, { id: 7 })).toBeNull();
    expect(published).toEqual([7]);
  });

  it("adds the book-published publisher and subscriber to the queue", async () => {
    const { queues } = await parse("pg", { rabbitmq: true });
    const entry = queues![0]!;

    expect(entry.exchanges![0]!.publishers).toEqual([
      {
        name: "bookAdded",
        resolverName: "events_bookAdded",
        routingKey: "book.added",
        options: { persistent: true },
      },
      {
        name: "bookPublished",
        resolverName: "events_bookPublished",
        routingKey: "book.published",
        options: { persistent: true },
      },
    ]);
    expect(entry.queues!.map(({ name, bindings }) => ({ name, bindings }))).toEqual([
      { name: "onBookAdded", bindings: [{ exchange: "books", pattern: "book.added" }] },
      { name: "onBookPublished", bindings: [{ exchange: "books", pattern: "book.published" }] },
    ]);
  });

  it("publishes through the repository, then announces the book", async () => {
    const { operations } = await parse("pg", { rabbitmq: true });
    const stored = { id: 7, title: "Kindred", publishedYear: 1979, authorId: 2 };
    const log: unknown[] = [];
    const repository = {
      main: {
        books: {
          publish: async (id: number) => {
            await Promise.resolve();
            log.push(["publish", id]);
            return stored;
          },
        },
      },
    };
    const queues = {
      sendMessage: (...args: unknown[]) => {
        log.push(["send", ...args]);
        return true;
      },
    };

    expect(
      await operations.publishBook!.handler!({ repository, queues } as never, { id: 7 }),
    ).toEqual(stored);
    // The event follows the update: a reader who refetches on it sees the book.
    expect(log).toEqual([
      ["publish", 7],
      ["send", "events_bookPublished", { id: 7 }],
    ]);
  });

  it.each(ENGINES)("leaves publishBook out of the %s scaffold without --auth", (database) => {
    const files = render(database);

    expect(files["graphoria.ts"]).not.toContain("publishBook");
    expect(files["repository.ts"]).not.toContain("publish:");
  });

  it.each(["pg", "sqlite"] as const)(
    "keeps the %s auth token store in memory, unless Redis holds it",
    (database) => {
      expect(renderWith({ auth: true }, database)[".env"]!.split("\n")).toContain(
        "AUTH_STORE=memory",
      );
      const withRedis = renderWith({ auth: true, redis: true }, database)[".env"]!;
      expect(withRedis.split("\n")).toContain("AUTH_STORE=redis");
      expect(withRedis).not.toContain("AUTH_STORE=memory");
      expect(render(database)[".env"]).not.toContain("AUTH_STORE");
    },
  );

  it.each(ENGINES)(
    "gives the %s books a status, with two drafts after the six published",
    (database) => {
      const seed = renderWith({ auth: true }, database)["seed.sql"]!;

      expect(seed).toContain("-- addBook stores a draft; publishBook shows it to readers.");
      expect(seed).toContain(
        {
          pg: "status TEXT NOT NULL DEFAULT 'draft'",
          mysql: "status VARCHAR(20) NOT NULL DEFAULT 'draft'",
          mssql: "status NVARCHAR(20) NOT NULL DEFAULT N'draft'",
          sqlite: "status TEXT NOT NULL DEFAULT 'draft'",
        }[database],
      );
      expect(seed.match(/'published'\)/g)).toHaveLength(6);
      expect(seed.match(/'draft'\)/g)).toHaveLength(2);
      expect(seed.indexOf("'The Dispossessed'")).toBeGreaterThan(
        seed.indexOf("'Parable of the Sower'"),
      );
      expect(render(database)["seed.sql"]).not.toContain("status");
    },
  );

  it("seeds SQLite with two drafts, adds a draft and publishes it", async () => {
    const { Database } = await import("bun:sqlite");
    const project = join(dir, `sqlite-run-${seq++}`);
    const path = await writeProject(project, renderWith({ auth: true }, "sqlite"), [
      "graphoria.ts",
      "repository.ts",
      "seed.sql",
    ]);
    process.env.DB_FILE = join(project, "shop.db");
    const db = ConfigurationZod.parse(((await import(path)).default as (h: object) => unknown)({}))
      .databases[0]!;
    const connection = new Database(join(project, "shop.db"), { create: true });
    try {
      await db.onConnect!(connection as never, db as never);
      const count = (where: string) =>
        (connection.query(`SELECT COUNT(*) AS n FROM books WHERE ${where}`).get() as { n: number })
          .n;
      expect(count("1 = 1")).toBe(8);
      expect(count("status = 'draft'")).toBe(2);

      const repository = db.repository!(connection as never) as {
        books: {
          add(book: object): Promise<{ id: number }>;
          publish(id: number): Promise<unknown>;
        };
      };
      const added = await repository.books.add({
        title: "The Lathe of Heaven",
        publishedYear: 1971,
        authorId: 1,
      });
      expect(added.id).toBe(9);
      expect(count("id = 9 AND status = 'draft'")).toBe(1);

      expect(await repository.books.publish(9)).toEqual({
        id: 9,
        title: "The Lathe of Heaven",
        publishedYear: 1971,
        authorId: 1,
      });
      expect(count("status = 'draft'")).toBe(2);
      expect(await repository.books.publish(99)).toBeNull();
    } finally {
      connection.close();
    }
  });
});

describe("renderProject with the frontend", () => {
  const renderWeb = (database: DatabaseType) =>
    renderProject({ ...values(database), frontend: true }, versions);

  const WEB_PATHS = [
    "bunfig.toml",
    "web/App.tsx",
    "web/frontend.tsx",
    "web/graphql.ts",
    "web/index.html",
    "web/styles.css",
  ];

  // The seed's schema, which prefixes its field names: a MySQL schema is its database.
  const SCHEMAS = { pg: "public", mysql: "shop", mssql: "dbo", sqlite: "main" } as const;

  it.each(ENGINES)("renders seventeen files for %s", (database) => {
    expect(Object.keys(renderWeb(database)).sort()).toEqual([...PATHS, ...WEB_PATHS].sort());
  });

  it("lists the added files in FRONTEND_FILES", () => {
    expect(Array.from<string>(FRONTEND_FILES).sort()).toEqual(WEB_PATHS);
  });

  it("pins React and Tailwind to the playgrounds' versions", async () => {
    const playgrounds = JSON.parse(await readFile(PLAYGROUNDS, "utf8"));
    const repo = { ...playgrounds.dependencies, ...playgrounds.devDependencies };
    const exact = (name: string) => repo[name].replace(/^[\^~]/, "");
    const pkg = JSON.parse(renderWeb("pg")["package.json"]!);

    expect(pkg.dependencies).toMatchObject({
      "@graphoria/server": "^0.6.0",
      react: exact("react"),
      "react-dom": exact("react-dom"),
      tailwindcss: exact("tailwindcss"),
      "bun-plugin-tailwind": exact("bun-plugin-tailwind"),
    });
    expect(pkg.devDependencies).toEqual({
      "@types/bun": "latest",
      "@types/react": exact("@types/react"),
      "@types/react-dom": exact("@types/react-dom"),
      typescript: "^6.0.0",
    });
  });

  it("pins urql and gql.tada to exact versions, as runtime dependencies", () => {
    const pkg = JSON.parse(renderWeb("pg")["package.json"]!);

    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@graphoria/server",
      "bun-plugin-tailwind",
      "gql.tada",
      "react",
      "react-dom",
      "tailwindcss",
      "urql",
    ]);
    expect(pkg.dependencies.urql).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["gql.tada"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("adds the queue client packages only with RabbitMQ", () => {
    const plain = JSON.parse(renderWeb("pg")["package.json"]!);
    const queued = JSON.parse(
      renderProject({ ...values("pg"), frontend: true, rabbitmq: true }, versions)["package.json"]!,
    );

    expect(plain.dependencies).not.toHaveProperty("graphql-ws");
    expect(plain.dependencies).not.toHaveProperty("@urql/core");
    expect(queued.dependencies["graphql-ws"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(queued.dependencies["@urql/core"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps the frontend packages out without the frontend", () => {
    const pkg = JSON.parse(renderWith({ rabbitmq: true })["package.json"]!);

    expect(pkg.dependencies).not.toHaveProperty("graphql-ws");
    expect(pkg.dependencies).not.toHaveProperty("urql");
  });

  it("prints the schemas in dev and generates the types from them", () => {
    const pkg = JSON.parse(renderWeb("pg")["package.json"]!);

    expect(pkg.scripts).toEqual({
      dev: "PRINT_SCHEMAS=true bun --watch index.ts",
      start: "bun index.ts",
      types: "gql-tada generate output",
    });
  });

  it("types JSX, the DOM and the anonymous schema's queries", () => {
    const { compilerOptions } = JSON.parse(renderWeb("pg")["tsconfig.json"]!);

    expect(compilerOptions.lib).toEqual(["ESNext", "DOM"]);
    expect(compilerOptions.jsx).toBe("react-jsx");
    expect(compilerOptions.allowImportingTsExtensions).toBe(true);
    expect(compilerOptions.plugins).toEqual([
      {
        name: "gql.tada/ts-plugin",
        schema: "./.graphoria/schemas/schema_anonymous.graphql",
        tadaOutputLocation: "./web/graphql-env.d.ts",
      },
    ]);
  });

  it("serves the app on / next to Graphoria's routes", () => {
    const index = renderWeb("pg")["index.ts"]!;

    expect(index).toContain("createHandlers(");
    expect(index).not.toContain("createBunServer");
    expect(index).toContain('import web from "./web/index.html"');
    expect(index).toContain('"/": web');
    // A catch-all would replace the CORS preflight route, `${PREFIX}/*`.
    expect(index).not.toContain('"/*"');
  });

  it("drains its own server on SIGTERM", () => {
    const index = renderWeb("pg")["index.ts"]!;

    expect(index).toContain("handleSignals(server)");
  });

  it("builds the Tailwind classes and ignores the printed schemas", () => {
    const files = renderWeb("pg");

    expect(Bun.TOML.parse(files["bunfig.toml"]!)).toEqual({
      serve: { static: { plugins: ["bun-plugin-tailwind"] } },
    });
    expect(files["web/styles.css"]).toBe('@import "tailwindcss";\n');
    expect(files[".gitignore"]!.split("\n")).toContain(".graphoria");
  });

  it("loads the app and its styles from index.html", () => {
    const html = renderWeb("pg")["web/index.html"]!;

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('href="./styles.css"');
    expect(html).toContain('<script type="module" src="./frontend.tsx"></script>');
  });

  it("queries Graphoria over POST, since GET /graphql is the websocket", () => {
    const frontend = renderWeb("pg")["web/frontend.tsx"]!;

    expect(frontend).toContain('url: "/graphql"');
    expect(frontend).toContain("preferGetMethod: false");
  });

  it("opens the websocket and forwards subscriptions, only with RabbitMQ", () => {
    const queued = renderProject({ ...values("pg"), frontend: true, rabbitmq: true }, versions)[
      "web/frontend.tsx"
    ]!;
    const plain = renderWeb("pg")["web/frontend.tsx"]!;

    for (const marker of [
      'import { subscriptionExchange } from "@urql/core"',
      'import { createClient as createWSClient } from "graphql-ws"',
      "subscriptionExchange({",
      'url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/graphql`',
      'query: request.query ?? ""',
    ]) {
      expect(queued).toContain(marker);
    }
    expect(plain).not.toContain("subscriptionExchange");
    expect(plain).not.toContain("graphql-ws");
  });

  it("types the queries from the generated introspection", () => {
    expect(renderWeb("pg")["web/graphql.ts"]).toContain(
      'import type { introspection } from "./graphql-env.d.ts";',
    );
  });

  it.each(ENGINES)("queries the %s seed by its field names", (database) => {
    const app = renderWeb(database)["web/App.tsx"]!;
    const schema = SCHEMAS[database];

    expect(app).toContain(`${genResolverName(schema, "authors", "table")}(`);
    expect(app).toContain(`${genResolverName(schema, "books", "table")}(`);
    for (const other of Object.values(SCHEMAS).filter((name) => name !== schema)) {
      expect(app).not.toContain(`${other}_`);
    }
  });

  it.each(ENGINES)(
    "queries the %s seed's books in the cached operation with --redis",
    (database) => {
      const config = renderProject({ ...values(database), redis: true }, versions)["graphoria.ts"]!;

      expect(config).toContain(`${genResolverName(SCHEMAS[database], "books", "table")}(`);
    },
  );

  it("adds the book form to every frontend, refreshing on the queue event or after the POST", () => {
    const queued = renderProject({ ...values("pg"), frontend: true, rabbitmq: true }, versions)[
      "web/App.tsx"
    ]!;
    const plain = renderWeb("pg")["web/App.tsx"]!;

    for (const app of [queued, plain]) {
      expect(app).toContain('fetch("/rest/add-book"');
      expect(app).toContain("Add book");
    }
    for (const marker of [
      "const BookAddedSubscription = graphql(",
      "events_onBookAdded {",
      "const [subscription] = useSubscription({ query: BookAddedSubscription })",
      'if (subscription.data) reexecute({ requestPolicy: "network-only" });',
    ]) {
      expect(queued).toContain(marker);
    }
    expect(plain).toContain('reexecute({ requestPolicy: "network-only" });');
    for (const marker of ["useSubscription", "events_onBookAdded"]) {
      expect(plain).not.toContain(marker);
    }
  });

  it.each(ENGINES)("queries the %s seed in the queue frontend too", (database) => {
    const app = renderProject({ ...values(database), frontend: true, rabbitmq: true }, versions)[
      "web/App.tsx"
    ]!;
    const schema = SCHEMAS[database];

    expect(app).toContain(`${genResolverName(schema, "authors", "table")}(`);
    expect(app).toContain(`${genResolverName(schema, "books", "table")}(`);
  });

  it.each(ENGINES)(
    "runs the %s insert in repository.ts and publishes the queued event",
    (database) => {
      const files = renderProject(
        { ...values(database), frontend: true, rabbitmq: true },
        versions,
      );
      const config = files["graphoria.ts"]!;

      expect(config).toContain("addBook: operation.typed<Repository>()(");
      expect(config).toContain('queues.sendMessage("events_bookAdded"');
      expect(config).toContain('path: "/add-book"');
      expect(config).toContain('method: "POST"');
      expect(files["repository.ts"]).toContain(`satisfies CustomRepositoryFactory<"${database}">`);
      expect(files["repository.ts"]).toContain(
        {
          pg: 'RETURNING id, title, published_year AS "publishedYear", author_id AS "authorId"',
          mysql: "FROM books WHERE id = LAST_INSERT_ID()",
          mssql: "OUTPUT INSERTED.id, INSERTED.title",
          sqlite: ".get(book.title, book.publishedYear, book.authorId)",
        }[database],
      );
    },
  );

  describe("graphoria.ts", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "graphoria-init-frontend-"));
      process.env.DB_HOST = "db.internal";
      process.env.DB_PORT = "15432";
      process.env.DB_USER = "someone";
      process.env.DB_PASSWORD = "Pa55word.x";
      process.env.DB_NAME = "shop";
      process.env.RABBITMQ_HOST = "rabbit.internal";
      process.env.RABBITMQ_PORT = "5672";
      process.env.RABBITMQ_USER = "graphoria";
      process.env.RABBITMQ_PASSWORD = "rabbit-pass";
      process.env.RABBITMQ_VHOST = "/";
      process.env.REDIS_URL = "redis://cache.internal:6379";
    });

    afterAll(async () => {
      for (const key of [
        "DB_HOST",
        "DB_PORT",
        "DB_USER",
        "DB_PASSWORD",
        "DB_NAME",
        "RABBITMQ_HOST",
        "RABBITMQ_PORT",
        "RABBITMQ_USER",
        "RABBITMQ_PASSWORD",
        "RABBITMQ_VHOST",
        "REDIS_URL",
      ]) {
        delete process.env[key];
      }
      await rm(dir, { recursive: true, force: true });
    });

    let seq = 0;
    const parse = async (
      frontend: boolean,
      database: DatabaseType,
      patch: Partial<ProjectValues> = {},
    ) => {
      const path = await writeProject(
        join(dir, `${database}-${frontend}-${seq++}`),
        renderProject({ ...values(database), frontend, ...patch }, versions),
      );
      const configure = (await import(path)).default as (helpers: object) => unknown;
      return ConfigurationZod.parse(configure({}));
    };

    it.each(SERVER_ENGINES)(
      "grants anonymous the two %s seed tables, auth off",
      async (database) => {
        const { auth } = await parse(true, database);
        const schema = SCHEMAS[database];

        expect(auth.enabled).toBe(false);
        expect(Object.keys(auth.permissions)).toEqual(["anonymous"]);
        expect(auth.permissions.anonymous!.tables).toEqual({
          [genResolverName(schema, "authors", "table")]: { columns: "ALL" },
          [genResolverName(schema, "books", "table")]: { columns: "ALL" },
        });
      },
    );

    it.each([{}, { redis: true }])("grants nothing without the frontend for %j", async (patch) => {
      expect((await parse(false, "pg", patch)).auth.permissions).toEqual({});
    });

    it("says what else the grant opens to anyone", () => {
      const config = renderWith({ frontend: true, rabbitmq: true, ai: true })["graphoria.ts"]!;

      expect(config).toContain(
        "// Anyone can also add books through addBook and use the events queue.",
      );
      expect(config).toContain(
        "// Anyone can also ask the AI agent, which calls your LLM provider.",
      );
      expect(renderWeb("pg")["graphoria.ts"]).toContain(
        "// Anyone can also add books through addBook.\n",
      );
    });

    it.each([
      [
        { rabbitmq: true, ai: true },
        { queues: ["events"], ai: true, operations: ["addBook"] },
      ],
      [{ rabbitmq: true }, { queues: ["events"], operations: ["addBook"] }],
      [{ redis: true }, { operations: ["books", "addBook"] }],
      [{}, { operations: ["addBook"] }],
    ])("extends the anonymous grant for %j", async (patch, expected) => {
      const { auth } = await parse(true, "pg", patch);

      expect(auth.permissions.anonymous).toMatchObject(expected);
    });

    it.each(SERVER_ENGINES)(
      "parses the %s config with the add-book operation",
      async (database) => {
        const configuration = await parse(true, database, { rabbitmq: true });

        expect(configuration.operations.addBook!.rest).toMatchObject({
          path: "/add-book",
          method: "POST",
        });
      },
    );

    it("adds a book through the repository, publishes it, and answers the stored row", async () => {
      const { operations } = await parse(true, "pg", { rabbitmq: true });
      const book = { title: "Kindred", publishedYear: 1979, authorId: 2 };
      const stored = { id: 7, ...book };
      const added: unknown[] = [];
      const sent: unknown[][] = [];
      const repository = {
        main: {
          books: {
            add: async (input: unknown) => {
              added.push(input);
              return stored;
            },
          },
        },
      };
      const queues = {
        sendMessage: (...args: unknown[]) => {
          sent.push(args);
          return true;
        },
      };

      const answer = await operations.addBook!.handler!({ repository, queues } as never, book);

      expect(answer).toEqual(stored);
      expect(added).toEqual([book]);
      expect(sent).toEqual([["events_bookAdded", book]]);
    });

    it("adds a book through the repository and answers the stored row without RabbitMQ", async () => {
      const { operations } = await parse(true, "pg");
      const book = { title: "Kindred", publishedYear: 1979, authorId: 2 };
      const stored = { id: 7, ...book };
      const added: unknown[] = [];
      const repository = {
        main: {
          books: {
            add: async (input: unknown) => {
              added.push(input);
              return stored;
            },
          },
        },
      };

      // No queues at all: the handler must not reach for a broker it lacks.
      const answer = await operations.addBook!.handler!({ repository } as never, book);

      expect(answer).toEqual(stored);
      expect(added).toEqual([book]);
    });

    it("declares the stored row, id included, as addBook's output", async () => {
      const { operations } = await parse(true, "pg", { rabbitmq: true });
      const output = operations.addBook!.output!;
      const book = { title: "Kindred", publishedYear: 1979, authorId: 2 };

      expect(output.safeParse({ id: 7, ...book }).success).toBe(true);
      expect(output.safeParse(book).success).toBe(false);
    });

    it("puts books and addBook in one operations block, and grants anonymous both", async () => {
      const configuration = await parse(true, "pg", { rabbitmq: true, redis: true });

      expect(Object.keys(configuration.operations)).toEqual(["books", "addBook"]);
      expect(configuration.auth.permissions.anonymous).toMatchObject({
        operations: ["books", "addBook"],
      });
    });
  });
});

describe("renderProject with --auth --frontend", () => {
  const renderAuthWeb = (database: DatabaseType, patch: Partial<ProjectValues> = {}) =>
    renderProject({ ...values(database), frontend: true, auth: true, ...patch }, versions);
  const TABLES = { pg: "public", mysql: "shop", mssql: "dbo", sqlite: "main" } as const;

  it("depends on @graphoria/react at the running version, only with --auth --frontend", () => {
    const dependencies = (patch: Partial<ProjectValues>) =>
      JSON.parse(renderWith(patch)["package.json"]!).dependencies;

    expect(dependencies({ auth: true, frontend: true })["@graphoria/react"]).toBe("^0.6.0");
    expect(dependencies({ auth: true })).not.toHaveProperty("@graphoria/react");
    expect(dependencies({ frontend: true })).not.toHaveProperty("@graphoria/react");
  });

  it("types the app's queries from the editor's schema", () => {
    const { compilerOptions } = JSON.parse(renderAuthWeb("pg")["tsconfig.json"]!);

    expect(compilerOptions.plugins[0].schema).toBe("./.graphoria/schemas/schema_editor.graphql");
  });

  it("wraps the app in AuthProvider and sends the token with every request", () => {
    const frontend = renderAuthWeb("pg")["web/frontend.tsx"]!;

    for (const marker of [
      'import { AuthProvider, getAccessToken, useAuth } from "@graphoria/react";',
      "<AuthProvider<Role>>",
      "return token ? { headers: { Authorization: `Bearer ${token}` } } : {};",
      "const client = useMemo(createClient, [user?.role]);",
      "preferGetMethod: false",
    ]) {
      expect(frontend).toContain(marker);
    }
    expect(frontend).not.toContain("graphql-ws");
  });

  it("authenticates the websocket and reopens it on a new token, with RabbitMQ", () => {
    const frontend = renderAuthWeb("pg", { rabbitmq: true })["web/frontend.tsx"]!;

    for (const marker of [
      'import { createClient as createWSClient } from "graphql-ws";',
      "return token ? { Authorization: `Bearer ${token}` } : {};",
      "subscribeAccessToken(() => wsClient.terminate());",
      "subscriptionExchange({",
    ]) {
      expect(frontend).toContain(marker);
    }
  });

  it.each(ENGINES)("reads the authors signed out and the %s catalog signed in", (database) => {
    const app = renderAuthWeb(database)["web/App.tsx"]!;
    const schema = TABLES[database];

    expect(app).toContain('export type Role = "reader" | "editor";');
    expect(app).toContain(
      `query Authors {\n    ${schema}_authors(orderBy: [{ id: ASC }]) {\n      id\n      name\n    }\n  }`,
    );
    expect(app).toContain(`${schema}_books(orderBy: [{ published_year: ASC }]) {`);
    expect(app).toContain("        status\n");
    expect(app).toContain("return user ? <Catalog role={user.role} /> : <SignIn />;");
  });

  it("signs in through useAuth().login, keeping its own pending state", () => {
    const app = renderAuthWeb("pg")["web/App.tsx"]!;

    expect(app).toContain("const { login, error } = useAuth<Role>();");
    expect(app).toContain("await login(username, password);");
    expect(app).toContain("disabled={submitting}");
    expect(app).toContain('{error && <p className="text-red-600">{error}</p>}');
  });

  it("shows the add-book form and Publish to an editor only, sending the token", () => {
    const app = renderAuthWeb("pg")["web/App.tsx"]!;

    expect(app).toMatch(
      /\{role === "editor" && \(\s*<form className="mb-8 space-y-2" onSubmit=\{addBook\}>/,
    );
    expect(app).toMatch(
      /\{role === "editor" && \(\s*<button[\s\S]*?onClick=\{\(\) => void publish\(book\.id\)\}[\s\S]*?Publish/,
    );
    expect(app).toContain('post("/rest/add-book", {');
    expect(app).toContain('post("/rest/publish-book", { id });');
    expect(app).toContain("Authorization: `Bearer ${getAccessToken()}`,");
  });

  it("shows the catalog loading as a spinner by the heading, with or without login", () => {
    for (const app of [
      renderAuthWeb("pg")["web/App.tsx"]!,
      renderWith({ frontend: true })["web/App.tsx"]!,
    ]) {
      expect(app).toMatch(
        /<h1 className="text-3xl font-bold">Authors<\/h1>\s*\{fetching && \(\s*<p [^>]*role="status">\s*<span\s*aria-hidden="true"/,
      );
      expect(app).toContain('<ul className="space-y-6" aria-busy={fetching}>');
      expect(app).not.toContain("Loading…");
    }
  });

  it("subscribes to the book-added events for an editor only, and to the published ones for both", () => {
    const queued = renderAuthWeb("pg", { rabbitmq: true })["web/App.tsx"]!;
    const plain = renderAuthWeb("pg")["web/App.tsx"]!;

    expect(queued).toContain("events_onBookAdded {");
    expect(queued).toContain("events_onBookPublished {");
    expect(queued).toContain(
      'useSubscription({\n    query: BookAddedSubscription,\n    pause: role !== "editor",',
    );
    expect(queued).toContain("useSubscription({\n    query: BookPublishedSubscription,\n  });");
    for (const subscription of ["subscriptionAdded", "subscriptionPublished"]) {
      expect(queued).toContain(
        `if (${subscription}.data) reexecute({ requestPolicy: "network-only" });`,
      );
    }
    expect(queued).toContain("// The list refreshes when the queued book-added event arrives.");
    expect(plain).not.toContain("useSubscription");
    expect(plain).toContain('    reexecute({ requestPolicy: "network-only" });\n    setTitle("");');
  });

  it("keeps the anonymous frontend without --auth", () => {
    const files = renderWith({ frontend: true });

    expect(files["web/App.tsx"]).not.toContain("@graphoria/react");
    expect(JSON.parse(files["tsconfig.json"]!).compilerOptions.plugins[0].schema).toBe(
      "./.graphoria/schemas/schema_anonymous.graphql",
    );
  });
});

describe("renderProject for SQLite", () => {
  const files = render("sqlite");

  it("points the project at a file, with no server settings", () => {
    const lines = files[".env"]!.split("\n");

    expect(lines).toContain("DB_FILE=shop.db");
    expect(lines.some((line) => /^DB_(HOST|PORT|USER|PASSWORD|NAME)=/.test(line))).toBe(false);
  });

  it("keeps the database file and its journals out of git and out of the image", () => {
    expect(files[".gitignore"]!.split("\n")).toEqual(expect.arrayContaining(["*.db", "*.db-*"]));
    expect(files[".dockerignore"]!.split("\n")).toEqual(expect.arrayContaining(["*.db", "*.db-*"]));
  });

  it("gives the runtime user a data directory in the image", () => {
    const lines = files.Dockerfile!.split("\n");

    expect(lines.indexOf("RUN mkdir -p data && chown bun:bun data")).toBeLessThan(
      lines.indexOf("USER bun"),
    );
    expect(lines).toContain("RUN mkdir -p data && chown bun:bun data");
  });

  it("runs Graphoria alone in Compose, with the file on a volume", () => {
    const compose = Bun.YAML.parse(files["docker-compose.yml"]!) as {
      services: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };

    expect(Object.keys(compose.services)).toEqual(["graphoria"]);
    expect(compose.services.graphoria!.environment).toEqual({ DB_FILE: "data/shop.db" });
    expect(compose.services.graphoria!.volumes).toEqual(["db-data:/app/data"]);
    expect(Object.keys(compose.volumes)).toEqual(["db-data"]);
  });

  it("creates the seed tables in SQLite's dialect", () => {
    expect(files["seed.sql"]).toContain("id INTEGER PRIMARY KEY");
    expect(files["seed.sql"]).toContain("'Ursula K. Le Guin'");

    const statements = files["seed.sql"]!.replace(/^--.*\n/gm, "").trim();
    expect(statements).toStartWith("BEGIN;");
    expect(statements).toEndWith("COMMIT;");
  });

  describe("graphoria.ts", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "graphoria-init-sqlite-"));
    });

    afterAll(async () => {
      delete process.env.DB_FILE;
      await rm(dir, { recursive: true, force: true });
    });

    const load = async (frontend: boolean) => {
      const project = join(dir, `sqlite-${frontend}`);
      const path = await writeProject(
        project,
        renderProject({ ...values("sqlite"), frontend }, versions),
        ["graphoria.ts", "repository.ts", "seed.sql"],
      );
      process.env.DB_FILE = join(project, "shop.db");
      return ConfigurationZod.parse(((await import(path)).default as (h: object) => unknown)({}));
    };

    it("reads the file from DB_FILE and seeds it once, on connect", async () => {
      const { Database } = await import("bun:sqlite");
      const configuration = await load(false);
      const db = configuration.databases[0]!;

      expect(db.type).toBe("sqlite");
      expect(db.connection).toEqual({ filename: join(dir, "sqlite-false", "shop.db") });

      const connection = new Database(join(dir, "sqlite-false", "shop.db"), { create: true });
      try {
        await db.onConnect!(connection as never, db as never);
        await db.onConnect!(connection as never, db as never);

        expect(connection.query("SELECT COUNT(*) AS n FROM authors").get()).toEqual({ n: 3 });
        expect(connection.query("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 6 });
      } finally {
        connection.close();
      }
    });

    it("grants anonymous the two seed tables with the frontend", async () => {
      const { auth } = await load(true);

      expect(auth.permissions.anonymous!.tables).toEqual({
        main_authors: { columns: "ALL" },
        main_books: { columns: "ALL" },
      });
    });

    it("adds a book through the repository and answers the stored row", async () => {
      const { Database } = await import("bun:sqlite");
      const db = (await load(false)).databases[0]!;
      const connection = new Database(join(dir, "sqlite-false", "shop.db"), { create: true });
      try {
        await db.onConnect!(connection as never, db as never);
        const repository = db.repository!(connection as never) as {
          books: { add(book: object): Promise<unknown> };
        };

        expect(
          await repository.books.add({ title: "Kindred", publishedYear: 1979, authorId: 2 }),
        ).toEqual({ id: 7, title: "Kindred", publishedYear: 1979, authorId: 2 });
        expect(connection.query("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 7 });
      } finally {
        connection.close();
      }
    });
  });
});

describe("renderProject types the add-book operation", () => {
  let dir: string;

  afterAll(() => rm(dir, { recursive: true, force: true }));

  // One tsc run over every engine's graphoria.ts and repository.ts, with and
  // without --auth, plus copies that call the repository wrongly: their errors
  // must be the only ones.
  it("type-checks every engine's scaffold and rejects wrong repository calls", async () => {
    dir = await mkdtemp(join(tmpdir(), "graphoria-init-types-"));
    const files: string[] = [];
    const write = async (
      project: string,
      rendered: Record<string, string>,
      edit = (text: string) => text,
    ) => {
      await mkdir(join(dir, project));
      for (const name of ["graphoria.ts", "repository.ts"]) {
        if (rendered[name] === undefined) continue;
        await writeFile(join(dir, project, name), edit(rendered[name]));
        files.push(`${project}/${name}`);
      }
    };
    const everything = {
      frontend: true,
      rabbitmq: true,
      redis: true,
      ai: true,
      mcp: true,
      cron: true,
    };
    for (const database of ENGINES) {
      await write(database, renderWith(everything, database));
      await write(`${database}-plain`, renderWith({}, database));
      await write(`${database}-auth`, renderWith({ ...everything, auth: true }, database));
    }
    await write("typo", renderWith(everything), (text) =>
      text.replace("repository.main.books.add(", "repository.main.books.ad("),
    );
    await write("publish-typo", renderWith({ ...everything, auth: true }), (text) =>
      text.replace("repository.main.books.publish(", "repository.main.books.publsh("),
    );
    const { compilerOptions } = JSON.parse(renderWith({ frontend: true })["tsconfig.json"]!);
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          ...compilerOptions,
          typeRoots: [
            dirname(dirname(Bun.resolveSync("@types/bun/package.json", import.meta.dir))),
          ],
          paths: { "@graphoria/server/config": [CONFIG_SOURCE] },
        },
        files,
      }),
    );

    const tsc = Bun.spawnSync(
      [process.execPath, Bun.resolveSync("typescript/bin/tsc", import.meta.dir), "-p", dir],
      { cwd: dir },
    );
    const errors = tsc.stdout
      .toString()
      .split("\n")
      .filter((line) => line.includes("error TS"));

    expect(errors).toHaveLength(2);
    expect(errors.find((line) => line.startsWith("typo/graphoria.ts("))).toContain(
      "Property 'ad' does not exist",
    );
    expect(errors.find((line) => line.startsWith("publish-typo/graphoria.ts("))).toContain(
      "Property 'publsh' does not exist",
    );
  }, 60_000);
});

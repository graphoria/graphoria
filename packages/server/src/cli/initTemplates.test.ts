import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseType } from "../config";

import { genResolverName } from "../databases/transformers/genResolverName";
import { ConfigurationZod } from "../types/zod/configuration";
import { FRONTEND_FILES, PROJECT_FILES, renderProject, type ProjectValues } from "./initTemplates";

const STARTER = join(import.meta.dir, "../../../../examples/docker-compose-starter");
const PLAYGROUNDS = join(import.meta.dir, "../../../playgrounds/package.json");

const values = (database: DatabaseType): ProjectValues => ({
  database,
  name: "my-api",
  dbName: "shop",
  dbPassword: "Pa55word.x",
  dbPort: 15432,
  rabbitmq: false,
  ai: false,
  redis: false,
  frontend: false,
  rabbitmqPassword: "rabbit-pass",
  adminSecret: "admin-secret-value",
  jwtSecret: "jwt-secret-value",
});

const versions = { graphoria: "0.6.0", bun: "1.4.2" };

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
  "seed.sql",
  "tsconfig.json",
];

describe("renderProject paths", () => {
  it.each(ENGINES)("renders the same ten files for %s", (database) => {
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
    "points the cache and auth token store at Redis for %s",
    (database) => {
      const lines = renderWith({ redis: true }, database)[".env"]!.split("\n");

      expect(lines).toContain("REDIS_URL=redis://localhost:6379");
      expect(lines).toContain("CACHE_STORE=redis");
      expect(render(database)[".env"]).not.toContain("REDIS_URL");
      expect(render(database)[".env"]).not.toContain("CACHE_STORE");
    },
  );

  it("adds every feature's settings together without overlap", () => {
    const lines = renderWith({ rabbitmq: true, ai: true, redis: true })[".env"]!.split("\n");

    expect(lines).toContain("DB_HOST=localhost");
    expect(lines).toContain("RABBITMQ_HOST=localhost");
    expect(lines).toContain("LLM_PROVIDER=ollama");
    expect(lines).toContain("REDIS_URL=redis://localhost:6379");
    expect(lines).toContain("CACHE_STORE=redis");
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
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  let seq = 0;
  const load = async (database: DatabaseType, patch: Partial<ProjectValues> = {}) => {
    const path = join(dir, `${database}-${seq++}.graphoria.ts`);
    await writeFile(path, renderWith({ ...patch }, database)["graphoria.ts"]!);
    const module = await import(path);
    return module.default as (helpers: object) => unknown;
  };

  const setEnv = () => {
    process.env.DB_HOST = "db.internal";
    process.env.DB_PORT = "15432";
    process.env.DB_USER = "someone";
    process.env.DB_PASSWORD = "Pa55word.x";
    process.env.DB_NAME = "shop";
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
    expect(entry.queues![0]).toMatchObject({
      name: "onBookAdded",
      bindings: [{ exchange: "books", pattern: "book.*" }],
    });
    expect(typeof entry.queues![0]!.handler).toBe("function");
  });

  it("enables the AI agent only when asked", async () => {
    setEnv();

    expect(ConfigurationZod.parse((await load("pg", { ai: true }))({})).ai.enabled).toBe(true);
    expect(ConfigurationZod.parse((await load("pg", {}))({})).ai.enabled).toBe(false);
  });

  it.each([
    { rabbitmq: true },
    { ai: true },
    { rabbitmq: true, ai: true },
    { redis: true },
    { rabbitmq: true, ai: true, redis: true },
  ])("still parses with %j", async (patch) => {
    setEnv();
    setRabbitEnv();

    const configure = await load("pg", patch);
    expect(() => ConfigurationZod.parse(configure({}))).not.toThrow();
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

  it.each(ENGINES)("renders sixteen files for %s", (database) => {
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

  it("adds the book form and refreshes on the queue event, only with RabbitMQ", () => {
    const queued = renderProject({ ...values("pg"), frontend: true, rabbitmq: true }, versions)[
      "web/App.tsx"
    ]!;
    const plain = renderWeb("pg")["web/App.tsx"]!;

    for (const marker of [
      "const BookAddedSubscription = graphql(",
      "events_onBookAdded {",
      "const [subscription] = useSubscription({ query: BookAddedSubscription })",
      'reexecute({ requestPolicy: "network-only" })',
      'fetch("/rest/add-book"',
      "Add book",
    ]) {
      expect(queued).toContain(marker);
    }
    for (const marker of ["useSubscription", "events_onBookAdded", "/rest/add-book"]) {
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

  it("imports the operation helper only for the queue frontend", () => {
    const queued = renderProject({ ...values("pg"), frontend: true, rabbitmq: true }, versions)[
      "graphoria.ts"
    ]!;
    const plain = renderWeb("pg")["graphoria.ts"]!;

    expect(queued).toContain('import { operation, z } from "@graphoria/server/config";');
    expect(plain).not.toContain("import { operation");
  });

  it("emits no operations without the frontend", () => {
    expect(renderWith({ rabbitmq: true })["graphoria.ts"]).not.toContain("operation(");
  });

  it.each(ENGINES)("runs the %s insert and publishes the queued event", (database) => {
    const config = renderProject({ ...values(database), frontend: true, rabbitmq: true }, versions)[
      "graphoria.ts"
    ]!;

    expect(config).toContain("addBook: operation(");
    expect(config).toContain('queues.sendMessage("events_bookAdded"');
    expect(config).toContain('path: "/add-book"');
    expect(config).toContain('method: "POST"');
    expect(config).toContain(
      database === "pg"
        ? "VALUES ($1, $2, $3)"
        : database === "mysql"
          ? "VALUES (?, ?, ?)"
          : database === "mssql"
            ? "@publishedYear"
            : ".run(input.title",
    );
  });

  describe("graphoria.ts", () => {
    let dir: string;

    beforeAll(async () => {
      // Under bun:test, a dynamic import from tmpdir cannot resolve the workspace
      // package `@graphoria/server`, which the queue frontend's config imports.
      dir = await mkdtemp(join(import.meta.dir, "../../../.graphoria-init-frontend-"));
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
      const path = join(dir, `${database}-${frontend}-${seq++}.graphoria.ts`);
      await writeFile(
        path,
        renderProject({ ...values(database), frontend, ...patch }, versions)["graphoria.ts"]!,
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

    it("grants nothing without the frontend", async () => {
      expect((await parse(false, "pg")).auth.permissions).toEqual({});
    });

    it("keeps the anonymous grant on one line without --rabbitmq or --ai", () => {
      const config = renderWeb("pg")["graphoria.ts"]!;

      expect(config).toContain('anonymous: { tables: ["public_authors", "public_books"] },');
      expect(config).not.toContain("anonymous: {\n");
    });

    it.each([
      [
        { rabbitmq: true, ai: true },
        { queues: ["events"], ai: true, operations: ["addBook"] },
      ],
      [{ rabbitmq: true }, { queues: ["events"], operations: ["addBook"] }],
      [{ redis: true }, {}],
      [{}, {}],
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
      const path = join(dir, `sqlite-${frontend}.graphoria.ts`);
      await writeFile(
        path,
        renderProject({ ...values("sqlite"), frontend }, versions)["graphoria.ts"]!,
      );
      await writeFile(join(dir, "seed.sql"), files["seed.sql"]!);
      process.env.DB_FILE = join(dir, "shop.db");
      return ConfigurationZod.parse(((await import(path)).default as (h: object) => unknown)({}));
    };

    it("reads the file from DB_FILE and seeds it once, on connect", async () => {
      const { Database } = await import("bun:sqlite");
      const configuration = await load(false);
      const db = configuration.databases[0]!;

      expect(db.type).toBe("sqlite");
      expect(db.connection).toEqual({ filename: join(dir, "shop.db") });

      const connection = new Database(join(dir, "shop.db"), { create: true });
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
  });
});

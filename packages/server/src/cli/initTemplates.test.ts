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
  frontend: false,
  adminSecret: "admin-secret-value",
  jwtSecret: "jwt-secret-value",
});

const versions = { graphoria: "0.6.0", bun: "1.4.2" };

const render = (database: DatabaseType) => renderProject(values(database), versions);

const ENGINES: DatabaseType[] = ["pg", "mysql", "mssql"];

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
    services: { db: Service; graphoria: Service; "db-init"?: Service };
    volumes: Record<string, unknown>;
  };
  const compose = (database: DatabaseType) =>
    Bun.YAML.parse(render(database)["docker-compose.yml"]!) as Compose;

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
});

describe("renderProject graphoria.ts", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "graphoria-init-templates-"));
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  afterEach(() => {
    for (const key of ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const load = async (database: DatabaseType) => {
    const path = join(dir, `${database}.graphoria.ts`);
    await writeFile(path, render(database)["graphoria.ts"]!);
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

  it.each(ENGINES)("reads the %s connection from the environment", async (database) => {
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
  const SCHEMAS = { pg: "public", mysql: "shop", mssql: "dbo" } as const;

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

  describe("graphoria.ts", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "graphoria-init-frontend-"));
      process.env.DB_HOST = "db.internal";
      process.env.DB_PORT = "15432";
      process.env.DB_USER = "someone";
      process.env.DB_PASSWORD = "Pa55word.x";
      process.env.DB_NAME = "shop";
    });

    afterAll(async () => {
      for (const key of ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
        delete process.env[key];
      }
      await rm(dir, { recursive: true, force: true });
    });

    const parse = async (frontend: boolean, database: DatabaseType) => {
      const path = join(dir, `${database}-${frontend}.graphoria.ts`);
      await writeFile(
        path,
        renderProject({ ...values(database), frontend }, versions)["graphoria.ts"]!,
      );
      const configure = (await import(path)).default as (helpers: object) => unknown;
      return ConfigurationZod.parse(configure({}));
    };

    it.each(ENGINES)("grants anonymous the two %s seed tables, auth off", async (database) => {
      const { auth } = await parse(true, database);
      const schema = SCHEMAS[database];

      expect(auth.enabled).toBe(false);
      expect(Object.keys(auth.permissions)).toEqual(["anonymous"]);
      expect(auth.permissions.anonymous!.tables).toEqual({
        [genResolverName(schema, "authors", "table")]: { columns: "ALL" },
        [genResolverName(schema, "books", "table")]: { columns: "ALL" },
      });
    });

    it("grants nothing without the frontend", async () => {
      expect((await parse(false, "pg")).auth.permissions).toEqual({});
    });
  });
});

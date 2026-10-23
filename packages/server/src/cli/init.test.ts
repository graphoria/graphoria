import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InitArgs } from "./initArgs";
import type { InitAnswers } from "./initTemplates";

import {
  collectAnswers,
  findConflicts,
  generatePassword,
  generateSecret,
  isPortFree,
  nextSteps,
  passwordError,
  portWarning,
  projectName,
  recreateCommand,
  sampleQuery,
} from "./init";

const ARGS: InitArgs = { yes: false, install: true };

const prompter = (answers: (string | null)[]) => {
  const fallbacks: string[] = [];
  const said: string[] = [];
  return {
    fallbacks,
    said,
    ask: (_question: string, fallback: string) => {
      fallbacks.push(fallback);
      return answers.length > 0 ? answers.shift()! : null;
    },
    say: (line: string) => {
      said.push(line);
    },
  };
};

describe("collectAnswers", () => {
  it("takes every default on EOF", () => {
    const io = prompter([]);
    const answers = collectAnswers(ARGS, io.ask, io.say);

    expect(answers.database).toBe("pg");
    expect(answers.dbName).toBe("app");
    expect(answers.dbPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(answers.dbPort).toBe(5432);
    expect(answers.frontend).toBe(false);
    expect(answers.auth).toBe(false);
    expect(io.fallbacks).toEqual([
      "pg",
      "app",
      answers.dbPassword,
      "5432",
      "n",
      "n",
      "n",
      "n",
      "n",
      "n",
    ]);
    expect(io.said).toEqual([]);
  });

  it("takes the default on an empty line", () => {
    const io = prompter(["", " ", "", ""]);
    const answers = collectAnswers(ARGS, io.ask, io.say);

    expect(answers).toMatchObject({ database: "pg", dbName: "app", dbPort: 5432 });
    expect(answers.dbPassword).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it("takes the answers given", () => {
    const io = prompter(["mysql", " shop ", "S3cret.pass", "13306"]);

    expect(collectAnswers(ARGS, io.ask, io.say)).toEqual({
      database: "mysql",
      dbName: "shop",
      dbPassword: "S3cret.pass",
      dbPort: 13306,
      rabbitmq: false,
      ai: false,
      auth: false,
      redis: false,
      dataTools: false,
      frontend: false,
    });
  });

  it("skips the engine question when --database chose it, and defaults to its port", () => {
    const io = prompter([]);
    const answers = collectAnswers({ ...ARGS, database: "mssql" }, io.ask, io.say);

    expect(answers.database).toBe("mssql");
    expect(answers.dbPort).toBe(1433);
    expect(io.fallbacks).toEqual(["app", answers.dbPassword, "1433", "n", "n", "n", "n", "n", "n"]);
  });

  it("skips the name and port questions when --db-name and --db-port answered them", () => {
    const io = prompter([]);
    const answers = collectAnswers({ ...ARGS, dbName: "shop", dbPort: 15432 }, io.ask, io.say);

    expect(answers).toMatchObject({ dbName: "shop", dbPort: 15432 });
    expect(io.fallbacks).toEqual(["pg", answers.dbPassword, "n", "n", "n", "n", "n", "n"]);
  });

  it.each([
    { what: "an unknown engine", answers: ["oracle", "mysql"], want: { database: "mysql" } },
    { what: "an uppercase name", answers: ["pg", "My-DB", "shop"], want: { dbName: "shop" } },
    { what: "a name with a dash", answers: ["pg", "my-db", "my_db"], want: { dbName: "my_db" } },
    {
      what: "a password with $",
      answers: ["pg", "shop", "pa$$word", "password"],
      want: { dbPassword: "password" },
    },
    {
      what: "a password starting with -",
      answers: ["pg", "shop", "-password", "pass-word"],
      want: { dbPassword: "pass-word" },
    },
    {
      what: "a weak SQL Server password",
      answers: ["mssql", "shop", "abcdefgh", "Abcdefg1"],
      want: { dbPassword: "Abcdefg1" },
    },
    {
      what: "a short SQL Server password",
      answers: ["mssql", "shop", "Ab1.", "Ab1.Ab1."],
      want: { dbPassword: "Ab1.Ab1." },
    },
    {
      what: "a port out of range",
      answers: ["pg", "shop", "pw", "70000", "15432"],
      want: { dbPort: 15432 },
    },
    {
      what: "a port that is not a number",
      answers: ["pg", "shop", "pw", "54x", "15432"],
      want: { dbPort: 15432 },
    },
    { what: "port 0", answers: ["pg", "shop", "pw", "0", "15432"], want: { dbPort: 15432 } },
  ])("asks again after $what, saying why", ({ answers, want }) => {
    const io = prompter([...answers]);

    expect(collectAnswers(ARGS, io.ask, io.say)).toMatchObject(want);
    expect(io.fallbacks).toHaveLength(11);
    expect(io.said).toHaveLength(1);
  });

  it("takes the default after EOF on a re-ask", () => {
    const io = prompter(["pg", "My-DB", null]);

    expect(collectAnswers(ARGS, io.ask, io.say).dbName).toBe("app");
  });

  it.each(["y", "yes", "Y", "YES", " Yes "])("adds the frontend on %p", (answer) => {
    const io = prompter(["pg", "shop", "pw", "15432", "n", "n", "n", "n", "n", answer]);

    expect(collectAnswers(ARGS, io.ask, io.say).frontend).toBe(true);
  });

  it.each(["", "n", "no", "N", "No"])("leaves the frontend out on %p", (answer) => {
    const io = prompter(["pg", "shop", "pw", "15432", "n", "n", "n", "n", "n", answer]);

    expect(collectAnswers(ARGS, io.ask, io.say).frontend).toBe(false);
    expect(io.said).toEqual([]);
  });

  it("asks the frontend question again after another answer, saying why", () => {
    const io = prompter(["pg", "shop", "pw", "15432", "n", "n", "n", "n", "n", "maybe", "y"]);

    expect(collectAnswers(ARGS, io.ask, io.say).frontend).toBe(true);
    expect(io.fallbacks).toHaveLength(11);
    expect(io.said).toHaveLength(1);
  });

  it.each([true, false])("skips the frontend question when --frontend is %p", (frontend) => {
    const io = prompter([]);
    const answers = collectAnswers({ ...ARGS, frontend }, io.ask, io.say);

    expect(answers.frontend).toBe(frontend);
    expect(io.fallbacks).toEqual([
      "pg",
      "app",
      answers.dbPassword,
      "5432",
      "n",
      "n",
      "n",
      "n",
      "n",
    ]);
  });

  it("asks neither a password nor a port for SQLite, which has no server", () => {
    const io = prompter([]);
    const answers = collectAnswers({ ...ARGS, database: "sqlite" }, io.ask, io.say);

    expect(answers).toEqual({
      database: "sqlite",
      dbName: "app",
      dbPassword: "",
      dbPort: 0,
      rabbitmq: false,
      ai: false,
      auth: false,
      redis: false,
      dataTools: false,
      frontend: false,
    });
    expect(io.fallbacks).toEqual(["app", "n", "n", "n", "n", "n", "n"]);
  });

  it.each([
    ["y", "yes"],
    ["Y", "no"],
  ])("adds RabbitMQ and the AI agent on %p", (rabbitAnswer, aiAnswer) => {
    const io = prompter(["pg", "shop", "pw", "15432", rabbitAnswer, aiAnswer]);
    const answers = collectAnswers(ARGS, io.ask, io.say);

    expect(answers.rabbitmq).toBe(true);
    expect(answers.ai).toBe(aiAnswer === "yes");
  });

  it.each([true, false])("skips the RabbitMQ question when --rabbitmq is %p", (rabbitmq) => {
    const io = prompter(["pg", "shop", null, "15432", "n"]);
    const answers = collectAnswers({ ...ARGS, rabbitmq }, io.ask, io.say);

    expect(answers.rabbitmq).toBe(rabbitmq);
    expect(io.fallbacks).toEqual([
      "pg",
      "app",
      answers.dbPassword,
      "5432",
      "n",
      "n",
      "n",
      "n",
      "n",
    ]);
  });

  it.each([true, false])("skips the AI question when --ai is %p", (ai) => {
    const io = prompter(["pg", "shop", "pw", "15432", "n"]);
    const answers = collectAnswers({ ...ARGS, ai }, io.ask, io.say);

    expect(answers.ai).toBe(ai);
  });

  it("asks for login with two roles right after the AI question", () => {
    const questions: string[] = [];
    collectAnswers(
      ARGS,
      (question) => {
        questions.push(question);
        return null;
      },
      () => {},
    );

    expect(questions.slice(5, 8)).toEqual([
      "Enable the AI agent? (y/N)",
      "Add login with two roles, reader and editor? (y/N)",
      "Add Redis? (y/N)",
    ]);
  });

  it.each(["y", "yes"])("adds login with two roles on %p", (answer) => {
    const io = prompter(["pg", "shop", "pw", "15432", "n", "n", answer]);

    expect(collectAnswers(ARGS, io.ask, io.say).auth).toBe(true);
  });

  it.each([true, false])("skips the auth question when --auth is %p", (auth) => {
    const io = prompter([]);
    const answers = collectAnswers({ ...ARGS, auth }, io.ask, io.say);

    expect(answers.auth).toBe(auth);
    expect(io.fallbacks).toEqual([
      "pg",
      "app",
      answers.dbPassword,
      "5432",
      "n",
      "n",
      "n",
      "n",
      "n",
    ]);
  });

  it.each([true, false])("skips the Redis question when --redis is %p", (redis) => {
    const io = prompter(["pg", "shop", "pw", "15432", "n", "n"]);
    const answers = collectAnswers({ ...ARGS, redis }, io.ask, io.say);

    expect(answers.redis).toBe(redis);
  });

  it.each([true, false])("skips the data-tools question when --data-tools is %p", (dataTools) => {
    const io = prompter(["pg", "shop", "pw", "15432", "n", "n", "n"]);
    const answers = collectAnswers({ ...ARGS, dataTools }, io.ask, io.say);

    expect(answers.dataTools).toBe(dataTools);
  });
});

describe("passwordError", () => {
  it.each(["pg", "mysql"] as const)("takes any non-empty safe password for %s", (database) => {
    expect(passwordError(database, "x")).toBeUndefined();
    expect(passwordError(database, "A-z0.9_~!@%^*+=:?")).toBeUndefined();
  });

  it.each(["$", "#", "'", '"', " ", ",", "`", "\\", "é"])("rejects %p", (char) => {
    expect(passwordError("pg", `pass${char}word`)).toBeString();
  });

  it("rejects a MySQL password Bun's client cannot log in with", () => {
    expect(passwordError("mysql", "abcdefghijKLMNOPQ12")).toBeUndefined();
    expect(passwordError("mysql", "abcdefghijKLMNOPQ123")).toBeString();
    expect(passwordError("pg", "abcdefghijKLMNOPQ123")).toBeUndefined();
    expect(passwordError("mssql", "abcdefghijKLMNOPQ123")).toBeUndefined();
  });

  it("rejects a password SQL Server would refuse at startup", () => {
    expect(passwordError("mssql", "Abcdef1")).toBeString();
    expect(passwordError("mssql", "abcdefg1")).toBeString();
    expect(passwordError("mssql", "abcdefg.")).toBeString();
    expect(passwordError("mssql", "abcdef.1")).toBeUndefined();
    expect(passwordError("mssql", "ABCDEF.1")).toBeUndefined();
  });
});

describe("generatePassword", () => {
  it("always passes every engine's rule", () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(passwordError("pg", password)).toBeUndefined();
      expect(passwordError("mysql", password)).toBeUndefined();
      expect(passwordError("mssql", password)).toBeUndefined();
    }
  });
});

describe("generateSecret", () => {
  it("is 32 random bytes in base64url", () => {
    const secret = generateSecret();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(secret);
  });
});

describe("projectName", () => {
  it.each([
    ["/tmp/My Cool API", "my-cool-api"],
    ["/tmp/api@v2", "api-v2"],
    ["/tmp/.hidden_app", "hidden_app"],
    ["/tmp/shop.api", "shop.api"],
    ["/", "graphoria-app"],
    ["/tmp/...", "graphoria-app"],
    ["/tmp/ÅÄÖ", "graphoria-app"],
  ])("names %p %p", (dir, name) => {
    expect(projectName(dir)).toBe(name);
  });

  it("stays within npm's 214 characters", () => {
    expect(projectName(`/tmp/${"a".repeat(300)}`)).toBe("a".repeat(214));
  });
});

describe("findConflicts", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "graphoria-init-"));
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "README.md"), "# mine");
    await mkdir(join(dir, ".env"));
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("returns only the paths that exist, files or not", () => {
    expect(findConflicts(dir, ["package.json", "tsconfig.json", ".env", "seed.sql"])).toEqual([
      "package.json",
      ".env",
    ]);
  });
});

describe("portWarning", () => {
  const busy = new Set([5432, 5433]);
  const isFree = (port: number) => !busy.has(port);
  const db = { service: "database", envVar: "DB_PORT" };

  it("says nothing when the port is free", () => {
    expect(portWarning(6000, db, isFree)).toBeUndefined();
  });

  it("names the next free port when the port is taken", () => {
    const warning = portWarning(5432, db, isFree);

    expect(warning).toContain("5432");
    expect(warning).toContain("5434");
    expect(warning).toContain("DB_PORT");
  });

  it("names the service and variable it is warning about", () => {
    const warning = portWarning(
      5672,
      { service: "RabbitMQ", envVar: "RABBITMQ_PORT" },
      () => false,
    );

    expect(warning).toContain("RabbitMQ");
    expect(warning).toContain("RABBITMQ_PORT");
  });
});

describe("isPortFree", () => {
  it("sees a port another listener holds", () => {
    const holder = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });

    expect(isPortFree(holder.port)).toBe(false);
    holder.stop(true);
    expect(isPortFree(holder.port)).toBe(true);
  });
});

describe("sampleQuery", () => {
  it.each([
    ["pg", "{ public_authors { name public_books { title } } }"],
    ["mysql", "{ shop_authors { name shop_books { title } } }"],
    ["mssql", "{ dbo_authors { name dbo_books { title } } }"],
    ["sqlite", "{ main_authors { name main_books { title } } }"],
  ] as const)("uses the %s schema's field names", (database, query) => {
    expect(sampleQuery({ database, dbName: "shop" })).toBe(query);
  });
});

const ANSWERS: InitAnswers = {
  database: "pg",
  dbName: "app",
  dbPassword: "S3cret.pass",
  dbPort: 5432,
  rabbitmq: false,
  ai: false,
  auth: false,
  redis: false,
  dataTools: false,
  frontend: false,
};

describe("recreateCommand", () => {
  it("turns every choice into a flag, with --yes so nothing is asked", () => {
    expect(
      recreateCommand(
        {
          ...ANSWERS,
          rabbitmq: true,
          ai: true,
          auth: true,
          redis: true,
          dataTools: true,
          frontend: true,
        },
        true,
      ),
    ).toBe(
      "bunx graphoria init --yes --database pg --db-name app --db-port 5432 --rabbitmq --ai --auth --redis --data-tools --frontend",
    );
  });

  it("leaves out the port SQLite does not have", () => {
    expect(recreateCommand({ ...ANSWERS, database: "sqlite", dbPort: 0 }, true)).toBe(
      "bunx graphoria init --yes --database sqlite --db-name app",
    );
  });

  it("adds --no-install when the install was skipped", () => {
    expect(recreateCommand(ANSWERS, false)).toBe(
      "bunx graphoria init --yes --database pg --db-name app --db-port 5432 --no-install",
    );
  });

  it("never carries a password", () => {
    expect(recreateCommand(ANSWERS, true)).not.toContain(ANSWERS.dbPassword);
  });
});

describe("nextSteps", () => {
  it("closes with the command that recreates the answers", () => {
    expect(nextSteps(ANSWERS, true)).toContain(
      "Recreate this setup in a new directory without prompts (the secrets are regenerated):\n  bunx graphoria init --yes --database pg --db-name app --db-port 5432",
    );
  });

  it("names Redis Commander only when Redis brings it along", () => {
    expect(nextSteps({ ...ANSWERS, dataTools: true }, true)).toContain(
      "dbgate explores the database at http://localhost:9000",
    );
    expect(nextSteps({ ...ANSWERS, dataTools: true }, true)).not.toContain("Redis Commander");

    expect(nextSteps({ ...ANSWERS, dataTools: true, redis: true }, true)).toContain(
      "Redis Commander inspects Redis at http://localhost:8081.",
    );
  });

  const USERS = { reader: "ReaderPass123", editor: "EditorPass456" };

  it("prints a seed-auth command per role, with its password, only with auth", () => {
    const steps = nextSteps({ ...ANSWERS, auth: true }, true, USERS);

    expect(steps).toContain(
      "Two demo users, one per role. Once the database is up, create them:\n" +
        "  bunx graphoria seed-auth --user reader --password ReaderPass123 --role reader --config ./graphoria.ts\n" +
        "  bunx graphoria seed-auth --user editor --password EditorPass456 --role editor --config ./graphoria.ts\n" +
        "Without a token you read the authors. A reader also reads the published books; an editor\n" +
        "reads every book, adds drafts (addBook) and publishes them (publishBook).\n" +
        "Log in with auth_login in GraphiQL or POST /rest/auth/login, then send\n" +
        "Authorization: Bearer <access_token>.\n",
    );
    expect(nextSteps(ANSWERS, true, USERS)).not.toContain("seed-auth");
  });

  it("refuses auth without the demo users' passwords, which it must print", () => {
    expect(() => nextSteps({ ...ANSWERS, auth: true }, true)).toThrow("demo users' passwords");
  });

  it("puts the seed-auth commands right after the run instructions", () => {
    const steps = nextSteps({ ...ANSWERS, auth: true, rabbitmq: true }, true, USERS);

    expect(steps.indexOf("Two demo users")).toBeGreaterThan(steps.indexOf("  bun run dev"));
    expect(steps.indexOf("Two demo users")).toBeLessThan(steps.indexOf("RabbitMQ management UI"));
  });

  it("says to run them in the container only for SQLite", () => {
    const line =
      "(SQLite in Docker: run them inside the container, prefixed with `docker compose exec graphoria`.)";

    expect(
      nextSteps({ ...ANSWERS, database: "sqlite", dbPort: 0, auth: true }, true, USERS),
    ).toContain(line);
    expect(nextSteps({ ...ANSWERS, auth: true }, true, USERS)).not.toContain(line);
  });

  it("offers the app's sign-in only with the frontend", () => {
    expect(nextSteps({ ...ANSWERS, auth: true, frontend: true }, true, USERS)).toContain(
      "Authorization: Bearer <access_token>, or sign in at http://localhost:3000.",
    );
  });

  it("says who may call the queue, the agent and the cached route with auth", () => {
    const steps = nextSteps(
      { ...ANSWERS, auth: true, rabbitmq: true, ai: true, redis: true },
      true,
      USERS,
    );

    expect(steps).toContain(
      "Publish with the events_bookAdded mutation; subscribe with events_onBookAdded. Both take an editor's token or the admin secret.",
    );
    expect(steps).toContain(
      "The AI agent answers /rest/ai and GraphiQL's ask field for a reader or an editor.",
    );
    expect(steps).toContain(
      "Redis caches GET /rest/books, for a reader or an editor, behind each process's own copy (caches in graphoria.ts). AUTH_STORE in .env points the auth token store at it, and RATE_LIMIT_STORE the rate limits once you turn them on. With bun run dev, start it first: a token the server cannot check there reads as no token.",
    );
    expect(steps).toContain(
      "Try, as a reader, an editor or with the admin secret: { public_authors { name public_books { title } } }",
    );
  });

  it("starts Redis for a host run only when auth keeps its tokens there", () => {
    const withAuth = { ...ANSWERS, auth: true, redis: true };

    expect(nextSteps(withAuth, true, USERS)).toContain(
      "  docker compose up -d --wait db redis\n  bun run dev\n",
    );
    expect(nextSteps({ ...withAuth, database: "sqlite", dbPort: 0 }, true, USERS)).toContain(
      "seeds it:\n  docker compose up -d --wait redis\n  bun run dev\n",
    );
    expect(nextSteps({ ...withAuth, database: "mssql" }, true, USERS)).toContain(
      "  docker compose run --rm db-init\n  docker compose up -d --wait redis\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, redis: true }, true)).toContain(
      "  docker compose up -d --wait db\n  bun run dev\n",
    );
  });

  it("never prints a demo password in the recreate command", () => {
    const recreate = nextSteps({ ...ANSWERS, auth: true }, true, USERS)
      .split("\n")
      .at(-1)!;

    expect(recreate).toContain("--auth");
    expect(recreate).not.toContain(USERS.reader);
    expect(recreate).not.toContain(USERS.editor);
  });

  it("prints the same steps without auth, whatever users are passed", () => {
    const answers = { ...ANSWERS, rabbitmq: true, ai: true, redis: true, frontend: true };

    expect(nextSteps(answers, true, USERS)).toBe(nextSteps(answers, true));
  });
});

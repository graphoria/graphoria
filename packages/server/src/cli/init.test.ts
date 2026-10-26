import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InitIO } from "./init";
import type { InitArgs } from "./initArgs";
import type { InitAnswers } from "./initTemplates";
import type { Choice } from "./prompt";

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

type Menus = { select?: number[]; multiSelect?: number[][] };

const prompter = (answers: (string | null)[] = [], menus: Menus = {}) => {
  const fallbacks: string[] = [];
  const said: string[] = [];
  const selected: string[] = [];
  const multi: string[] = [];
  const multiOptions: string[][] = [];
  const io: InitIO = {
    ask: (_question: string, fallback: string) => {
      fallbacks.push(fallback);
      return answers.length > 0 ? answers.shift()! : null;
    },
    say: (line: string) => {
      said.push(line);
    },
    select: <T>(_question: string, choices: readonly Choice<T>[], initial: number) => {
      selected.push(_question);
      const index = menus.select?.shift();
      return choices[index ?? initial].value;
    },
    multiSelect: <T>(_question: string, choices: readonly Choice<T>[], initial: readonly T[]) => {
      multi.push(_question);
      multiOptions.push(choices.map((choice) => choice.label));
      const picks = menus.multiSelect?.shift();
      return picks === undefined ? [...initial] : picks.map((index) => choices[index].value);
    },
  };
  return { fallbacks, multi, multiOptions, said, selected, io };
};

describe("collectAnswers", () => {
  it("takes every default on EOF", async () => {
    const io = prompter([]);
    const answers = await collectAnswers(ARGS, io.io);

    expect(answers.database).toBe("pg");
    expect(answers.dbName).toBe("app");
    expect(answers.dbPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(answers.dbPort).toBe(5432);
    expect(answers.rabbitmq).toBe(false);
    expect(answers.ai).toBe(false);
    expect(answers.auth).toBe(false);
    expect(answers.redis).toBe(false);
    expect(answers.dataTools).toBe(false);
    expect(answers.frontend).toBe(false);
    expect(io.fallbacks).toEqual(["app", answers.dbPassword, "5432"]);
    expect(io.selected).toEqual(["Database engine"]);
    expect(io.multi).toEqual(["Select extras"]);
    expect(io.said).toEqual([]);
  });

  it("takes the default on an empty line", async () => {
    const io = prompter(["", " ", ""]);
    const answers = await collectAnswers(ARGS, io.io);

    expect(answers).toMatchObject({ database: "pg", dbName: "app", dbPort: 5432 });
    expect(answers.dbPassword).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it("takes the engine from the menu and the rest from the answers", async () => {
    const io = prompter([" shop ", "S3cret.pass", "13306"], {
      select: [1],
      multiSelect: [[0, 2]],
    });

    expect(await collectAnswers(ARGS, io.io)).toEqual({
      database: "mysql",
      dbName: "shop",
      dbPassword: "S3cret.pass",
      dbPort: 13306,
      rabbitmq: true,
      ai: false,
      auth: true,
      redis: false,
      dataTools: false,
      frontend: false,
    });
  });

  it("defaults the port to the engine chosen in the menu", async () => {
    const io = prompter(["shop", "pw"], { select: [1] });

    expect((await collectAnswers(ARGS, io.io)).dbPort).toBe(3306);
  });

  it("skips the engine question when --database chose it, and defaults to its port", async () => {
    const io = prompter([]);
    const answers = await collectAnswers({ ...ARGS, database: "mssql" }, io.io);

    expect(answers.database).toBe("mssql");
    expect(answers.dbPort).toBe(1433);
    expect(io.fallbacks).toEqual(["app", answers.dbPassword, "1433"]);
    expect(io.selected).toEqual([]);
  });

  it("skips the name and port questions when --db-name and --db-port answered them", async () => {
    const io = prompter([]);
    const answers = await collectAnswers({ ...ARGS, dbName: "shop", dbPort: 15432 }, io.io);

    expect(answers).toMatchObject({ dbName: "shop", dbPort: 15432 });
    expect(io.fallbacks).toEqual([answers.dbPassword]);
  });

  it.each([
    { what: "an uppercase name", engine: 0, answers: ["My-DB", "shop"], want: { dbName: "shop" } },
    {
      what: "a name with a dash",
      engine: 0,
      answers: ["my-db", "my_db"],
      want: { dbName: "my_db" },
    },
    {
      what: "a password with $",
      engine: 0,
      answers: ["shop", "pa$$word", "password"],
      want: { dbPassword: "password" },
    },
    {
      what: "a password starting with -",
      engine: 0,
      answers: ["shop", "-password", "pass-word"],
      want: { dbPassword: "pass-word" },
    },
    {
      what: "a weak SQL Server password",
      engine: 2,
      answers: ["shop", "abcdefgh", "Abcdefg1"],
      want: { dbPassword: "Abcdefg1" },
    },
    {
      what: "a short SQL Server password",
      engine: 2,
      answers: ["shop", "Ab1.", "Ab1.Ab1."],
      want: { dbPassword: "Ab1.Ab1." },
    },
    {
      what: "a port out of range",
      engine: 0,
      answers: ["shop", "pw", "70000", "15432"],
      want: { dbPort: 15432 },
    },
    {
      what: "a port that is not a number",
      engine: 0,
      answers: ["shop", "pw", "54x", "15432"],
      want: { dbPort: 15432 },
    },
    {
      what: "port 0",
      engine: 0,
      answers: ["shop", "pw", "0", "15432"],
      want: { dbPort: 15432 },
    },
  ])("asks again after $what, saying why", async ({ engine, answers, want }) => {
    const io = prompter([...answers], { select: [engine] });

    expect(await collectAnswers(ARGS, io.io)).toMatchObject(want);
    expect(io.fallbacks).toHaveLength(4);
    expect(io.said).toHaveLength(1);
  });

  it("takes the default after EOF on a re-ask", async () => {
    const io = prompter(["My-DB", null], { select: [0] });

    expect((await collectAnswers(ARGS, io.io)).dbName).toBe("app");
  });

  it("adds the extras ticked in the list", async () => {
    const io = prompter([], { multiSelect: [[0, 2, 5]] });
    const answers = await collectAnswers(ARGS, io.io);

    expect(answers).toMatchObject({ rabbitmq: true, ai: false, auth: true, frontend: true });
  });

  it("leaves every extra out when none is ticked", async () => {
    const io = prompter([]);
    const answers = await collectAnswers(ARGS, io.io);

    expect(answers).toMatchObject({
      rabbitmq: false,
      ai: false,
      auth: false,
      redis: false,
      dataTools: false,
      frontend: false,
    });
    expect(io.said).toEqual([]);
  });

  it("offers the extras in the order of their flags", async () => {
    const io = prompter();
    await collectAnswers(ARGS, io.io);

    expect(io.multiOptions[0]).toEqual([
      "RabbitMQ",
      "AI agent",
      "Login",
      "Redis",
      "Data tools",
      "React frontend",
    ]);
  });

  it("asks no extras when every flag answered them", async () => {
    const io = prompter();
    await collectAnswers(
      {
        ...ARGS,
        rabbitmq: false,
        ai: false,
        auth: false,
        redis: false,
        dataTools: false,
        frontend: false,
      },
      io.io,
    );

    expect(io.multi).toEqual([]);
  });

  it.each([true, false])("skips the RabbitMQ extra when --rabbitmq is %p", async (rabbitmq) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, rabbitmq }, io.io);

    expect(answers.rabbitmq).toBe(rabbitmq);
    expect(io.multiOptions[0]).not.toContain("RabbitMQ");
  });

  it.each([true, false])("skips the AI extra when --ai is %p", async (ai) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, ai }, io.io);

    expect(answers.ai).toBe(ai);
    expect(io.multiOptions[0]).not.toContain("AI agent");
  });

  it.each([true, false])("skips the login extra when --auth is %p", async (auth) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, auth }, io.io);

    expect(answers.auth).toBe(auth);
    expect(io.multiOptions[0]).not.toContain("Login");
  });

  it.each([true, false])("skips the Redis extra when --redis is %p", async (redis) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, redis }, io.io);

    expect(answers.redis).toBe(redis);
    expect(io.multiOptions[0]).not.toContain("Redis");
  });

  it.each([true, false])(
    "skips the data-tools extra when --data-tools is %p",
    async (dataTools) => {
      const io = prompter();
      const answers = await collectAnswers({ ...ARGS, dataTools }, io.io);

      expect(answers.dataTools).toBe(dataTools);
      expect(io.multiOptions[0]).not.toContain("Data tools");
    },
  );

  it.each([true, false])("skips the frontend extra when --frontend is %p", async (frontend) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, frontend }, io.io);

    expect(answers.frontend).toBe(frontend);
    expect(io.multiOptions[0]).not.toContain("React frontend");
  });

  it("asks neither a password nor a port for SQLite, which has no server", async () => {
    const io = prompter([]);
    const answers = await collectAnswers({ ...ARGS, database: "sqlite" }, io.io);

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
    expect(io.fallbacks).toEqual(["app"]);
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
      "publishBook publishes events_bookPublished; a reader too subscribes with events_onBookPublished.",
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

  it("starts the broker and Redis too for a host run", () => {
    const both = { ...ANSWERS, rabbitmq: true, redis: true };

    expect(nextSteps(both, true)).toContain(
      "  docker compose up -d --wait db rabbitmq redis\n  bun run dev\n",
    );
    expect(nextSteps({ ...both, database: "sqlite", dbPort: 0 }, true)).toContain(
      "seeds it:\n  docker compose up -d --wait rabbitmq redis\n  bun run dev\n",
    );
    expect(nextSteps({ ...both, database: "mssql" }, true)).toContain(
      "  docker compose run --rm db-init\n  docker compose up -d --wait rabbitmq redis\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, redis: true, auth: true }, true, USERS)).toContain(
      "  docker compose up -d --wait db redis\n  bun run dev\n",
    );
    expect(nextSteps(ANSWERS, true)).toContain("  docker compose up -d --wait db\n  bun run dev\n");
    expect(nextSteps({ ...ANSWERS, database: "sqlite", dbPort: 0 }, true)).toContain(
      "seeds it:\n  bun run dev\n",
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

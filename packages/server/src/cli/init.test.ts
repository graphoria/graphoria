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
  pickPorts,
  portNotes,
  portWarning,
  projectName,
  recreateCommand,
  sampleQuery,
  upCommand,
} from "./init";
import { DEFAULT_PORTS } from "./initTemplates";
import { COLOR_PAINT, PLAIN_PAINT } from "./paint";

const ARGS: InitArgs = { yes: false, install: true, up: false };

type Menus = { select?: number[]; multiSelect?: number[][] };

const prompter = (
  answers: (string | null)[] = [],
  menus: Menus = {},
  isPortFree: (port: number) => boolean = () => true,
) => {
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
    isPortFree,
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
    expect(answers.dbPortGiven).toBe(false);
    expect(answers.rabbitmq).toBe(false);
    expect(answers.ai).toBe(false);
    expect(answers.mcp).toBe(false);
    expect(answers.auth).toBe(false);
    expect(answers.redis).toBe(false);
    expect(answers.dataTools).toBe(false);
    expect(answers.frontend).toBe(false);
    expect(answers.trpc).toBe(false);
    expect(answers.cron).toBe(false);
    expect(answers.rateLimit).toBe(false);
    expect(answers.metrics).toBe(false);
    expect(answers.tracing).toBe(false);
    expect(answers.virtualColumns).toBe(false);
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
      multiSelect: [[0, 3]],
    });

    expect(await collectAnswers(ARGS, io.io)).toEqual({
      database: "mysql",
      dbName: "shop",
      dbPassword: "S3cret.pass",
      dbPort: 13306,
      dbPortGiven: true,
      rabbitmq: true,
      ai: false,
      mcp: false,
      auth: true,
      redis: false,
      dataTools: false,
      frontend: false,
      trpc: false,
      cron: false,
      rateLimit: false,
      metrics: false,
      tracing: false,
      virtualColumns: false,
      ports: DEFAULT_PORTS,
    });
  });

  it("offers the first free port from the engine's as the database port", async () => {
    const io = prompter([], {}, (port) => port !== 5432);
    const answers = await collectAnswers(ARGS, io.io);

    expect(io.fallbacks.at(-1)).toBe("5433");
    expect(answers.dbPort).toBe(5433);
    expect(answers.dbPortGiven).toBe(false);
  });

  it("keeps the --db-port it was given, taken or not", async () => {
    const io = prompter([], {}, () => false);

    expect(await collectAnswers({ ...ARGS, dbPort: 15432 }, io.io)).toMatchObject({
      dbPort: 15432,
      dbPortGiven: true,
    });
  });

  it("counts a port typed at the question as given, and the offered one as picked", async () => {
    const typed = await collectAnswers(ARGS, prompter(["app", "pw", "15432"]).io);
    const offered = await collectAnswers(ARGS, prompter(["app", "pw", "5432"]).io);

    expect(typed).toMatchObject({ dbPort: 15432, dbPortGiven: true });
    expect(offered).toMatchObject({ dbPort: 5432, dbPortGiven: false });
  });

  it("picks the published ports through the prober it was given", async () => {
    const io = prompter([], {}, (port) => port !== 3000);

    expect((await collectAnswers(ARGS, io.io)).ports.app).toBe(3001);
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
    const io = prompter([], { multiSelect: [[0, 2, 3, 6, 7, 8, 9, 10, 11, 12]] });
    const answers = await collectAnswers(ARGS, io.io);

    expect(answers).toMatchObject({
      rabbitmq: true,
      ai: false,
      mcp: true,
      auth: true,
      frontend: true,
      trpc: true,
      cron: true,
      rateLimit: true,
      metrics: true,
      tracing: true,
      virtualColumns: true,
    });
  });

  it("leaves every extra out when none is ticked", async () => {
    const io = prompter([]);
    const answers = await collectAnswers(ARGS, io.io);

    expect(answers).toMatchObject({
      rabbitmq: false,
      ai: false,
      mcp: false,
      auth: false,
      redis: false,
      dataTools: false,
      frontend: false,
      trpc: false,
      cron: false,
      rateLimit: false,
      metrics: false,
      tracing: false,
      virtualColumns: false,
    });
    expect(io.said).toEqual([]);
  });

  it("offers the extras in the order of their flags", async () => {
    const io = prompter();
    await collectAnswers(ARGS, io.io);

    expect(io.multiOptions[0]).toEqual([
      "RabbitMQ",
      "AI agent",
      "MCP server",
      "Login",
      "Redis",
      "Data tools",
      "React frontend",
      "tRPC",
      "Cron job",
      "Rate limits",
      "Metrics",
      "Tracing",
      "Computed column",
    ]);
  });

  it("asks no extras when every flag answered them", async () => {
    const io = prompter();
    await collectAnswers(
      {
        ...ARGS,
        rabbitmq: false,
        ai: false,
        mcp: false,
        auth: false,
        redis: false,
        dataTools: false,
        frontend: false,
        trpc: false,
        cron: false,
        rateLimit: false,
        metrics: false,
        tracing: false,
        virtualColumns: false,
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

  it.each([true, false])("skips the MCP extra when --mcp is %p", async (mcp) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, mcp }, io.io);

    expect(answers.mcp).toBe(mcp);
    expect(io.multiOptions[0]).not.toContain("MCP server");
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

  it.each([true, false])("skips the tRPC extra when --trpc is %p", async (trpc) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, trpc }, io.io);

    expect(answers.trpc).toBe(trpc);
    expect(io.multiOptions[0]).not.toContain("tRPC");
  });

  it.each([true, false])("skips the cron extra when --cron is %p", async (cron) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, cron }, io.io);

    expect(answers.cron).toBe(cron);
    expect(io.multiOptions[0]).not.toContain("Cron job");
  });

  it.each([true, false])(
    "skips the rate-limit extra when --rate-limit is %p",
    async (rateLimit) => {
      const io = prompter();
      const answers = await collectAnswers({ ...ARGS, rateLimit }, io.io);

      expect(answers.rateLimit).toBe(rateLimit);
      expect(io.multiOptions[0]).not.toContain("Rate limits");
    },
  );

  it.each([true, false])("skips the metrics extra when --metrics is %p", async (metrics) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, metrics }, io.io);

    expect(answers.metrics).toBe(metrics);
    expect(io.multiOptions[0]).not.toContain("Metrics");
  });

  it.each([true, false])("skips the tracing extra when --tracing is %p", async (tracing) => {
    const io = prompter();
    const answers = await collectAnswers({ ...ARGS, tracing }, io.io);

    expect(answers.tracing).toBe(tracing);
    expect(io.multiOptions[0]).not.toContain("Tracing");
  });

  it.each([true, false])(
    "skips the computed-column extra when --virtual-columns is %p",
    async (virtualColumns) => {
      const io = prompter();
      const answers = await collectAnswers({ ...ARGS, virtualColumns }, io.io);

      expect(answers.virtualColumns).toBe(virtualColumns);
      expect(io.multiOptions[0]).not.toContain("Computed column");
    },
  );

  it("asks neither a password nor a port for SQLite, which has no server", async () => {
    const io = prompter([]);
    const answers = await collectAnswers({ ...ARGS, database: "sqlite" }, io.io);

    expect(answers).toEqual({
      database: "sqlite",
      dbName: "app",
      dbPassword: "",
      dbPort: 0,
      dbPortGiven: false,
      rabbitmq: false,
      ai: false,
      mcp: false,
      auth: false,
      redis: false,
      dataTools: false,
      frontend: false,
      trpc: false,
      cron: false,
      rateLimit: false,
      metrics: false,
      tracing: false,
      virtualColumns: false,
      ports: DEFAULT_PORTS,
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

describe("pickPorts", () => {
  const everything = {
    database: "pg" as const,
    dbPort: 5432,
    redis: true,
    rabbitmq: true,
    dataTools: true,
    metrics: true,
    tracing: true,
  };

  it("publishes each service on its own port when every port is free", () => {
    expect(pickPorts(everything, () => true)).toEqual(DEFAULT_PORTS);
  });

  it("moves a taken port to the next free one, never onto a port it already gave", () => {
    const busy = new Set([3000, 6379, 6380]);
    const ports = pickPorts(everything, (port) => !busy.has(port));

    expect(ports).toMatchObject({ app: 3001, redis: 6381, grafana: 3002 });
  });

  it("leaves the database's port to the database", () => {
    expect(pickPorts({ ...everything, dbPort: 3000 }, () => true).app).toBe(3001);
    expect(pickPorts({ ...everything, database: "sqlite", dbPort: 0 }, () => true).app).toBe(3000);
  });

  it("probes only the ports the project publishes", () => {
    const probed: number[] = [];
    const plain = {
      database: "pg" as const,
      dbPort: 5432,
      redis: false,
      rabbitmq: false,
      dataTools: false,
      metrics: false,
      tracing: false,
    };
    const ports = pickPorts(plain, (port) => {
      probed.push(port);
      return true;
    });

    expect(probed).toEqual([3000]);
    expect(ports).toEqual(DEFAULT_PORTS);
  });
});

describe("portNotes", () => {
  const answers: InitAnswers = {
    database: "pg",
    dbName: "app",
    dbPassword: "S3cret.pass",
    dbPort: 5432,
    dbPortGiven: false,
    rabbitmq: true,
    ai: false,
    mcp: false,
    auth: false,
    redis: true,
    dataTools: true,
    frontend: false,
    trpc: false,
    cron: false,
    rateLimit: false,
    metrics: true,
    tracing: true,
    virtualColumns: false,
    ports: DEFAULT_PORTS,
  };

  it("says nothing when every port is the default and free", () => {
    expect(portNotes(answers, () => true)).toEqual([]);
  });

  it("names each moved port, the port it got and the variable that holds it", () => {
    const moved = { ...DEFAULT_PORTS, app: 3002, redis: 6380, jaegerOtlp: 4319, grafana: 3003 };

    expect(portNotes({ ...answers, ports: moved }, () => true)).toEqual([
      "Port 3000 is taken, so Graphoria uses 3002 instead (PORT in .env).",
      "Port 6379 is taken, so Redis uses 6380 instead (REDIS_PORT in .env).",
      "Port 4318 is taken, so Jaeger's OTLP receiver uses 4319 instead (JAEGER_OTLP_PORT in .env).",
      "Port 3001 is taken, so Grafana uses 3003 instead (GRAFANA_PORT in .env).",
    ]);
  });

  it("says when it moved the database off its engine's taken port, unless the port was given", () => {
    const isFree = (port: number) => port !== 5432;
    const moved = { ...answers, dbPort: 5433 };

    expect(portNotes(moved, isFree)).toEqual([
      "Port 5432 is taken, so the database uses 5433 instead (DB_PORT in .env).",
    ]);
    expect(portNotes({ ...moved, dbPortGiven: true }, isFree)).toEqual([]);
  });

  it("warns about a database port that is itself taken", () => {
    const given = { ...answers, dbPort: 15432, dbPortGiven: true };
    const [warning] = portNotes(given, (port) => port !== 15432);

    expect(warning).toStartWith(
      "Port 15432 is in use on this host, so Docker Compose cannot publish the database on it. Set DB_PORT in .env",
    );
  });

  it("has no database port to speak of on SQLite", () => {
    expect(portNotes({ ...answers, database: "sqlite", dbPort: 0 }, () => false)).toEqual([]);
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
    expect(sampleQuery({ database, dbName: "shop", virtualColumns: false })).toBe(query);
  });

  it("selects each book's computed age with --virtual-columns", () => {
    expect(sampleQuery({ database: "pg", dbName: "shop", virtualColumns: true })).toBe(
      "{ public_authors { name public_books { title age } } }",
    );
  });
});

const ANSWERS: InitAnswers = {
  database: "pg",
  dbName: "app",
  dbPassword: "S3cret.pass",
  dbPort: 5432,
  dbPortGiven: true,
  rabbitmq: false,
  ai: false,
  mcp: false,
  auth: false,
  redis: false,
  dataTools: false,
  frontend: false,
  trpc: false,
  cron: false,
  rateLimit: false,
  metrics: false,
  tracing: false,
  virtualColumns: false,
  ports: DEFAULT_PORTS,
};

describe("recreateCommand", () => {
  it("turns every choice into a flag, with --yes so nothing is asked", () => {
    expect(
      recreateCommand(
        {
          ...ANSWERS,
          rabbitmq: true,
          ai: true,
          mcp: true,
          auth: true,
          redis: true,
          dataTools: true,
          frontend: true,
          trpc: true,
          cron: true,
          rateLimit: true,
          metrics: true,
          tracing: true,
          virtualColumns: true,
        },
        true,
      ),
    ).toBe(
      "bunx graphoria init --yes --database pg --db-name app --db-port 5432 --rabbitmq --ai --mcp --auth --redis --data-tools --frontend --trpc --cron --rate-limit --metrics --tracing --virtual-columns",
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

  it("adds --up when init ran the project", () => {
    expect(recreateCommand(ANSWERS, true, true)).toBe(
      "bunx graphoria init --yes --database pg --db-name app --db-port 5432 --up",
    );
    expect(nextSteps(ANSWERS, true, undefined, PLAIN_PAINT, true)).toContain(
      "bunx graphoria init --yes --database pg --db-name app --db-port 5432 --up",
    );
  });

  it("leaves out a database port init picked, so a copy gets a free one", () => {
    expect(recreateCommand({ ...ANSWERS, dbPort: 5433, dbPortGiven: false }, true)).toBe(
      "bunx graphoria init --yes --database pg --db-name app",
    );
  });

  it("never carries a password", () => {
    expect(recreateCommand(ANSWERS, true)).not.toContain(ANSWERS.dbPassword);
  });
});

describe("upCommand", () => {
  it("runs bun run up where the project has it, docker compose up -d --build elsewhere", () => {
    expect(upCommand({ frontend: false, trpc: false })).toEqual([
      "docker",
      "compose",
      "up",
      "-d",
      "--build",
    ]);
    expect(upCommand({ frontend: true, trpc: false })).toEqual(["bun", "run", "up"]);
    expect(upCommand({ frontend: false, trpc: true })).toEqual(["bun", "run", "up"]);
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

  it.each([
    {
      what: "without auth",
      answers: { ...ANSWERS, mcp: true },
      caller: "without a header a client reads no table; send the admin secret.",
    },
    {
      what: "with the frontend's anonymous grant",
      answers: { ...ANSWERS, mcp: true, frontend: true },
      caller:
        "without a header a client reads what anyone reads; send the admin secret to read everything.",
    },
    {
      what: "with auth",
      answers: { ...ANSWERS, mcp: true, auth: true },
      caller:
        "without a header a client reads the authors; send a reader's or an editor's token, or the admin secret.",
    },
  ])("points MCP clients at /mcp and says what they read $what", ({ answers, caller }) => {
    expect(nextSteps(answers, true, USERS)).toContain(
      "The MCP server answers MCP clients at http://localhost:3000/mcp. Its tools run as the caller, as on /graphql:\n" +
        caller,
    );
    expect(nextSteps({ ...answers, mcp: false }, true, USERS)).not.toContain("/mcp");
  });

  it("says what the cron job logs, and where to read it in Docker", () => {
    expect(nextSteps({ ...ANSWERS, cron: true }, true)).toContain(
      "The cron job booksReport (cron in graphoria.ts) logs the number of books every minute; in Docker, read it with docker compose logs -f graphoria.",
    );
    expect(nextSteps({ ...ANSWERS, cron: true, auth: true }, true, USERS)).toContain(
      "logs the number of books and of drafts every minute",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("booksReport");
  });

  it.each([
    {
      what: "graphoria.ts with auth",
      answers: { ...ANSWERS, rateLimit: true, auth: true },
      anonymous: "rateLimit in graphoria.ts",
    },
    {
      what: "graphoria.ts with the frontend's grant",
      answers: { ...ANSWERS, rateLimit: true, frontend: true },
      anonymous: "rateLimit in graphoria.ts",
    },
    {
      what: ".env without an anonymous grant",
      answers: { ...ANSWERS, rateLimit: true },
      anonymous: "RATE_LIMIT_ANONYMOUS_MAX in .env",
    },
  ])("says what the rate limits allow, the anonymous one from $what", ({ answers, anonymous }) => {
    const limits = `Rate limits: an anonymous caller gets 60 requests a minute per address (${anonymous}), any other caller 600, the admin secret included (RATE_LIMIT_MAX in .env); past that, 429 with Retry-After.`;

    expect(nextSteps(answers, true, USERS)).toContain(`${limits} Each process counts on its own.`);
    expect(nextSteps({ ...answers, redis: true }, true, USERS)).toContain(
      `${limits} Redis holds the counts, shared by every process.`,
    );
    expect(nextSteps({ ...answers, rateLimit: false }, true, USERS)).not.toContain("Rate limits");
  });

  it("points Prometheus at /metrics with its own secret", () => {
    expect(nextSteps({ ...ANSWERS, metrics: true }, true)).toContain(
      "Metrics: http://localhost:3000/metrics answers Prometheus when the x-admin-secret header carries METRICS_SECRET from .env, a secret that opens nothing else.",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("/metrics");
  });

  it("opens Grafana on the dashboard, right after the metrics endpoint", () => {
    expect(nextSteps({ ...ANSWERS, metrics: true }, true)).toContain(
      "a secret that opens nothing else.\nGrafana opens on the Graphoria dashboard at http://localhost:3001 in the Docker run: Prometheus scrapes the graphoria service, not a host run.\n",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("Grafana");
  });

  it("starts neither Prometheus nor Grafana for a host run", () => {
    expect(nextSteps({ ...ANSWERS, metrics: true }, true)).toContain(
      "  docker compose up -d --wait db\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, database: "sqlite", dbPort: 0, metrics: true }, true)).toContain(
      "seeds it:\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, metrics: true }, true)).not.toContain("prometheus");
  });

  it("puts the Grafana line below Jaeger's with --tracing alone", () => {
    const steps = nextSteps({ ...ANSWERS, tracing: true }, true);

    expect(steps).toContain(
      "pick the service named OTEL_SERVICE_NAME in .env.\nGrafana shows the traces at http://localhost:3001, under Explore → Jaeger.\n",
    );
    expect(steps).not.toContain("Prometheus");
  });

  it("puts the Grafana line, traces included, below Jaeger's with --metrics and --tracing", () => {
    const steps = nextSteps({ ...ANSWERS, metrics: true, tracing: true }, true);

    expect(steps).toContain(
      "a secret that opens nothing else.\n\nJaeger shows a trace for each request, down to the SQL it ran, at http://localhost:16686: pick the service named OTEL_SERVICE_NAME in .env.\nGrafana opens on the Graphoria dashboard at http://localhost:3001 in the Docker run: Prometheus scrapes the graphoria service, not a host run; the traces are under Explore → Jaeger.\n",
    );
    expect(steps.split("\n").filter((line) => line.startsWith("Grafana"))).toHaveLength(1);
  });

  it("opens Jaeger's UI, and starts Jaeger and Grafana for a host run", () => {
    const steps = nextSteps({ ...ANSWERS, tracing: true }, true);

    expect(steps).toContain(
      "Jaeger shows a trace for each request, down to the SQL it ran, at http://localhost:16686: pick the service named OTEL_SERVICE_NAME in .env.",
    );
    expect(steps).toContain("  docker compose up -d --wait db jaeger grafana\n  bun run dev\n");
    expect(nextSteps({ ...ANSWERS, database: "sqlite", dbPort: 0, tracing: true }, true)).toContain(
      "seeds it:\n  docker compose up -d --wait jaeger grafana\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, redis: true, tracing: true }, true)).toContain(
      "  docker compose up -d --wait db redis jaeger grafana\n",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("jaeger");
  });

  it("starts Grafana but never Prometheus for a host run with --metrics and --tracing", () => {
    const steps = nextSteps({ ...ANSWERS, metrics: true, tracing: true }, true);

    expect(steps).toContain("  docker compose up -d --wait db jaeger grafana\n  bun run dev\n");
    expect(steps).not.toContain("prometheus");
  });

  it("says where tRPC serves the operations, and how a client types them", () => {
    expect(nextSteps({ ...ANSWERS, trpc: true }, true)).toContain(
      "\ntRPC serves the operations at http://localhost:3000/trpc (TRPC_ENABLED in .env); a call runs as its caller, as on /rest.\n" +
        "A client made with @trpc/client types them from graphoria.ts through TRPCRouterOf from @graphoria/server/trpc.\n",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("tRPC");
  });

  it("names the app's tRPC client only with --auth --frontend", () => {
    expect(
      nextSteps({ ...ANSWERS, trpc: true, auth: true, frontend: true }, true, USERS),
    ).toContain(
      "through TRPCRouterOf from @graphoria/server/trpc, as web/trpc.ts does for the app's Publish button.\n",
    );
    expect(nextSteps({ ...ANSWERS, trpc: true, frontend: true }, true)).not.toContain(
      "web/trpc.ts",
    );
    expect(nextSteps({ ...ANSWERS, trpc: true, auth: true }, true, USERS)).not.toContain(
      "web/trpc.ts",
    );
  });

  it("says where the computed age comes from, and selects it in the sample query", () => {
    const steps = nextSteps({ ...ANSWERS, virtualColumns: true }, true);

    expect(steps).toContain(
      "Computed column: each book's age, the years since it was published, is worked out by the database on every read (schema in graphoria.ts) and never stored.",
    );
    expect(steps).toContain("Try: { public_authors { name public_books { title age } } }");
    expect(nextSteps(ANSWERS, true)).not.toContain("age }");
  });

  it("says the rate limits are on in the Redis paragraph", () => {
    expect(
      nextSteps({ ...ANSWERS, redis: true, rateLimit: true, auth: true }, true, USERS),
    ).toContain(
      "AUTH_STORE in .env points the auth token store at it, and RATE_LIMIT_STORE the rate limits. With",
    );
    expect(nextSteps({ ...ANSWERS, redis: true, rateLimit: true }, true)).toContain(
      "RATE_LIMIT_STORE in .env points the rate limits at it, and AUTH_STORE the auth token store once you turn auth on.",
    );
  });

  it("runs bun run types before bun run dev whenever the project has the script", () => {
    expect(nextSteps({ ...ANSWERS, frontend: true }, true)).toContain(
      "  docker compose up -d --wait db\n  bun run types\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, database: "mssql", trpc: true }, true)).toContain(
      "  docker compose run --rm db-init\n  bun run types\n  bun run dev\n",
    );
    expect(nextSteps({ ...ANSWERS, database: "sqlite", dbPort: 0, trpc: true }, true)).toContain(
      "the first `bun run types` creates app.db and seeds it:\n  bun run types\n  bun run dev\n",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("bun run types");
  });

  it("runs everything in Docker with bun run up whenever the project has the script", () => {
    expect(nextSteps({ ...ANSWERS, frontend: true }, true)).toContain(
      "Run everything in Docker:\n  bun run up\n",
    );
    expect(nextSteps({ ...ANSWERS, database: "sqlite", dbPort: 0, trpc: true }, true)).toContain(
      "Or in Docker, with the database file on a volume:\n  bun run up",
    );
    expect(nextSteps(ANSWERS, true)).toContain(
      "Run everything in Docker:\n  docker compose up -d --build\n",
    );
    expect(nextSteps(ANSWERS, true)).not.toContain("bun run up");
  });

  it("links each service on the port init picked for it", () => {
    const ports = {
      ...DEFAULT_PORTS,
      app: 3005,
      rabbitmqManagement: 15673,
      dbgate: 9001,
      redisCommander: 8082,
      jaegerUi: 16687,
      grafana: 3006,
    };
    const steps = nextSteps(
      {
        ...ANSWERS,
        frontend: true,
        rabbitmq: true,
        redis: true,
        dataTools: true,
        mcp: true,
        trpc: true,
        metrics: true,
        tracing: true,
        ports,
      },
      true,
    );

    expect(steps).toContain(
      "then open http://localhost:3005 (the app) or http://localhost:3005/graphiql",
    );
    for (const url of [
      "http://localhost:3005/mcp",
      "http://localhost:3005/trpc",
      "http://localhost:3005/metrics",
      "management UI: http://localhost:15673",
      "the database at http://localhost:9001",
      "Redis at http://localhost:8082",
      "at http://localhost:16687",
      "at http://localhost:3006",
    ]) {
      expect(steps).toContain(url);
    }
    expect(steps).not.toContain("localhost:3000");
  });

  it("names the files bun run types writes, and when to run it again", () => {
    expect(nextSteps({ ...ANSWERS, frontend: true, trpc: true }, true)).toContain(
      "`bun run types` reads the database, with no server running, and writes\n" +
        "web/graphql-env.d.ts, which types the app's queries, and graphoria-env.d.ts, which types the plain-string operations. Commit both, and run it again\n" +
        "after a change to the tables or to graphoria.ts.\n",
    );
    expect(nextSteps({ ...ANSWERS, trpc: true }, true)).toContain(
      "\ngraphoria-env.d.ts, which types the plain-string operations. Commit it, and run it again\n",
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
    const answers = {
      ...ANSWERS,
      rabbitmq: true,
      ai: true,
      mcp: true,
      redis: true,
      frontend: true,
    };

    expect(nextSteps(answers, true, USERS)).toBe(nextSteps(answers, true));
  });

  it.each([
    {
      what: "every extra",
      answers: {
        ...ANSWERS,
        rabbitmq: true,
        ai: true,
        mcp: true,
        auth: true,
        redis: true,
        dataTools: true,
        frontend: true,
        trpc: true,
        cron: true,
        rateLimit: true,
        metrics: true,
        tracing: true,
        virtualColumns: true,
      },
      installed: true,
    },
    {
      what: "SQLite before bun install",
      answers: { ...ANSWERS, database: "sqlite" as const, dbPort: 0, auth: true, rabbitmq: true },
      installed: false,
    },
    {
      what: "SQL Server with Redis before bun install",
      answers: { ...ANSWERS, database: "mssql" as const, redis: true },
      installed: false,
    },
  ])("adds nothing but color codes for $what", ({ answers, installed }) => {
    expect(Bun.stripANSI(nextSteps(answers, installed, USERS, COLOR_PAINT))).toBe(
      nextSteps(answers, installed, USERS),
    );
  });

  it("colors what to type cyan and what to open blue", () => {
    const steps = nextSteps(
      { ...ANSWERS, dataTools: true, frontend: true },
      true,
      USERS,
      COLOR_PAINT,
    );

    expect(steps).toContain("\n  \x1b[36mbun run dev\x1b[39m\n");
    expect(steps).toContain("once \x1b[36m`docker compose up`\x1b[39m runs it.");
    expect(steps).toContain(
      "Try: \x1b[36m{ public_authors { name public_books { title } } }\x1b[39m",
    );
    expect(steps).toContain(
      "then open \x1b[94mhttp://localhost:3000\x1b[39m (the app) or \x1b[94mhttp://localhost:3000/graphiql\x1b[39m",
    );
  });

  it("colors the commands the AI and Redis paragraphs name", () => {
    const steps = nextSteps(
      { ...ANSWERS, ai: true, auth: true, redis: true },
      true,
      USERS,
      COLOR_PAINT,
    );

    expect(steps).toContain(
      "so use \x1b[36mbun run dev\x1b[39m, not \x1b[36mdocker compose up\x1b[39m.",
    );
    expect(steps).toContain("With \x1b[36mbun run dev\x1b[39m, start it first");
  });

  it("colors the command the cron paragraph names", () => {
    expect(nextSteps({ ...ANSWERS, cron: true }, true, USERS, COLOR_PAINT)).toContain(
      "read it with \x1b[36mdocker compose logs -f graphoria\x1b[39m.",
    );
  });

  it("bolds the name that opens each extra's paragraph, and colors the demo passwords yellow", () => {
    const steps = nextSteps(
      {
        ...ANSWERS,
        rabbitmq: true,
        ai: true,
        mcp: true,
        auth: true,
        redis: true,
        dataTools: true,
        trpc: true,
        cron: true,
        rateLimit: true,
        metrics: true,
        tracing: true,
        virtualColumns: true,
      },
      true,
      USERS,
      COLOR_PAINT,
    );

    for (const name of [
      "Two demo users",
      "RabbitMQ",
      "AI agent",
      "MCP server",
      "Redis",
      "dbgate",
      "Redis Commander",
      "tRPC",
      "cron job",
      "Rate limits",
      "Metrics",
      "Grafana",
      "Jaeger",
      "Computed column",
    ]) {
      expect(steps).toContain(`\x1b[1m${name}\x1b[22m`);
    }
    expect(steps).toContain(
      "  \x1b[36mbunx graphoria seed-auth --user reader --password \x1b[39m\x1b[33mReaderPass123\x1b[39m\x1b[36m --role reader --config ./graphoria.ts\x1b[39m",
    );
  });
});

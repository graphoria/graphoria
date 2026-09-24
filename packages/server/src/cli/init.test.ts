import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InitArgs } from "./initArgs";

import {
  collectAnswers,
  findConflicts,
  generatePassword,
  generateSecret,
  isPortFree,
  passwordError,
  portWarning,
  projectName,
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
    expect(io.fallbacks).toEqual(["pg", "app", answers.dbPassword, "5432"]);
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
    });
  });

  it("skips the engine question when --database chose it, and defaults to its port", () => {
    const io = prompter([]);
    const answers = collectAnswers({ ...ARGS, database: "mssql" }, io.ask, io.say);

    expect(answers.database).toBe("mssql");
    expect(answers.dbPort).toBe(1433);
    expect(io.fallbacks).toEqual(["app", answers.dbPassword, "1433"]);
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
    expect(io.fallbacks).toHaveLength(5);
    expect(io.said).toHaveLength(1);
  });

  it("takes the default after EOF on a re-ask", () => {
    const io = prompter(["pg", "My-DB", null]);

    expect(collectAnswers(ARGS, io.ask, io.say).dbName).toBe("app");
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

  it("says nothing when the port is free", () => {
    expect(portWarning(6000, isFree)).toBeUndefined();
  });

  it("names the next free port when the port is taken", () => {
    const warning = portWarning(5432, isFree);

    expect(warning).toContain("5432");
    expect(warning).toContain("5434");
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
  ] as const)("uses the %s schema's field names", (database, query) => {
    expect(sampleQuery({ database, dbName: "shop", dbPassword: "pw", dbPort: 1 })).toBe(query);
  });
});

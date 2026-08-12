import { describe, expect, it } from "bun:test";

import { parseSeedAuthArgs } from "./seedAuthArgs";

describe("parseSeedAuthArgs", () => {
  it("parses the full long-form invocation", () => {
    const args = parseSeedAuthArgs([
      "--user",
      "alice",
      "--password",
      "secret",
      "--role",
      "admin",
      "--config",
      "./custom.ts",
      "--claims",
      '{"tenant":"acme"}',
    ]);

    expect(args).toEqual({
      user: "alice",
      password: "secret",
      role: "admin",
      config: "./custom.ts",
      claims: { tenant: "acme" },
    });
  });

  it("supports short flags", () => {
    const args = parseSeedAuthArgs([
      "-u",
      "alice",
      "-p",
      "secret",
      "-r",
      "admin",
      "-c",
      "./graphoria.ts",
    ]);

    expect(args.user).toBe("alice");
    expect(args.password).toBe("secret");
    expect(args.role).toBe("admin");
    expect(args.config).toBe("./graphoria.ts");
    expect(args.claims).toEqual({});
  });

  it("requires --user", () => {
    expect(() => parseSeedAuthArgs(["--password", "p", "--role", "r"])).toThrow(
      "--user is required",
    );
  });

  it("requires --password", () => {
    expect(() => parseSeedAuthArgs(["--user", "u", "--role", "r"])).toThrow(
      "--password is required",
    );
  });

  it("requires --role", () => {
    expect(() => parseSeedAuthArgs(["--user", "u", "--password", "p"])).toThrow(
      "--role is required",
    );
  });

  it("requires --config", () => {
    expect(() => parseSeedAuthArgs(["--user", "u", "--password", "p", "--role", "r"])).toThrow(
      "--config is required",
    );
  });

  it("rejects malformed --claims", () => {
    expect(() =>
      parseSeedAuthArgs([
        ...["--user", "u", "--password", "p", "--role", "r", "--config", "./graphoria.ts"],
        ...["--claims", "{not-json"],
      ]),
    ).toThrow(/Invalid --claims JSON/);
  });

  it("rejects --claims that isn't a JSON object", () => {
    expect(() =>
      parseSeedAuthArgs([
        ...["--user", "u", "--password", "p", "--role", "r", "--config", "./graphoria.ts"],
        ...["--claims", "[]"],
      ]),
    ).toThrow(/--claims must be a JSON object/);
  });
});

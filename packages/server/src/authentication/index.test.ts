import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateKeys } from "paseto-ts/v4";

import type { TokenStrategy } from "./types";

import { createTokenService } from ".";
import { EnvZod } from "../types/env";
import { logger } from "../logging";

const adminSecret = "admin-secret";
const anonymousRole = "anonymous";

const localKey = generateKeys("local") as string;
const { secretKey, publicKey } = generateKeys("public") as {
  secretKey: string;
  publicKey: string;
};

describe("createTokenService", () => {
  it("creates JWT service by default", async () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      JWT_SECRET: "test-secret",
    });

    const service = createTokenService(env);
    const pair = await service.createTokenPair({ sub: "u", role: "r" });

    // JWT tokens start with "eyJ"
    expect(pair.access_token).toStartWith("eyJ");
  });

  it("creates JWT service for strategy 'jwt'", async () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      JWT_SECRET: "test-secret",
    });

    const service = createTokenService(env, "jwt");
    const pair = await service.createTokenPair({ sub: "u", role: "r" });
    expect(pair.access_token).toStartWith("eyJ");
  });

  it("creates PASETO local service", async () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      PASETO_LOCAL_KEY: localKey,
    });

    const service = createTokenService(env, "paseto_local");
    const pair = await service.createTokenPair({ sub: "u", role: "r" });
    expect(pair.access_token).toStartWith("v4.local.");
  });

  it("creates PASETO public service", async () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      PASETO_SECRET_KEY: secretKey,
      PASETO_PUBLIC_KEY: publicKey,
    });

    const service = createTokenService(env, "paseto_public");
    const pair = await service.createTokenPair({ sub: "u", role: "r" });
    expect(pair.access_token).toStartWith("v4.public.");
  });

  it("throws when JWT_SECRET is missing for jwt strategy", () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
    });

    expect(() => createTokenService(env, "jwt")).toThrow("JWT_SECRET");
  });

  it("throws when JWT_SECRET holds no usable entry", () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      JWT_SECRET: " , ",
    });

    expect(() => createTokenService(env, "jwt")).toThrow("JWT_SECRET");
  });

  it("throws when PASETO_PUBLIC_KEY holds no usable entry", () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      PASETO_SECRET_KEY: secretKey,
      PASETO_PUBLIC_KEY: ",",
    });

    expect(() => createTokenService(env, "paseto_public")).toThrow("PASETO_PUBLIC_KEY");
  });

  it("throws when PASETO_LOCAL_KEY is missing for paseto_local strategy", () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
    });

    expect(() => createTokenService(env, "paseto_local")).toThrow("PASETO_LOCAL_KEY");
  });

  it("throws when PASETO keys are missing for paseto_public strategy", () => {
    const env = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
    });

    expect(() => createTokenService(env, "paseto_public")).toThrow("PASETO_SECRET_KEY");
  });
});

describe("createTokenService when nothing signs tokens", () => {
  const STRATEGIES: TokenStrategy[] = ["jwt", "paseto_local", "paseto_public"];

  const keyless = EnvZod.parse({ ADMIN_SECRET: adminSecret, ANONYMOUS_ROLE: anonymousRole });

  const keyed = {
    jwt: EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      JWT_SECRET: "test-secret",
    }),
    paseto_local: EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      PASETO_LOCAL_KEY: localKey,
    }),
    paseto_public: EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      PASETO_SECRET_KEY: secretKey,
      PASETO_PUBLIC_KEY: publicKey,
    }),
  };

  const variable = {
    jwt: "JWT_SECRET",
    paseto_local: "PASETO_LOCAL_KEY",
    paseto_public: "PASETO_PUBLIC_KEY",
  } as const;

  const spyOnWarn = () => spyOn(logger("auth"), "warn").mockImplementation((() => {}) as never);
  let warn: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    warn = spyOnWarn();
  });

  afterEach(() => warn.mockRestore());

  const memberToken = async (strategy: TokenStrategy) => {
    const issuer = createTokenService(keyed[strategy], strategy);
    try {
      return await issuer.createToken({ sub: "u", role: "member" }, { audience: "access" });
    } finally {
      issuer.close();
    }
  };

  it.each(STRATEGIES)("%s: still throws without a key when one is required", (strategy) => {
    expect(() => createTokenService(keyless, strategy, true)).toThrow(variable[strategy]);
  });

  it.each(STRATEGIES)(
    "%s: without a key, warns once and treats every bearer token as anonymous",
    async (strategy) => {
      const token = await memberToken(strategy);
      const service = createTokenService(keyless, strategy, false);

      try {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toEqual({ strategy });
        expect(String(warn.mock.calls[0]![1])).toContain(variable[strategy]);

        expect(await service.verifyTokenAndGetSession(`Bearer ${token}`, null)).toEqual({
          sub: "anonymous",
          role: anonymousRole,
        });
        expect(await service.verifyTokenAndGetSession(null, adminSecret)).toEqual({
          sub: "superadmin",
          role: "superadmin",
          authMethod: "admin_secret",
        });
        await expect(service.createToken({ sub: "u", role: "member" })).rejects.toThrow();
      } finally {
        service.close();
      }
    },
  );

  it.each(STRATEGIES)(
    "%s: with the key, verifies as before and does not warn",
    async (strategy) => {
      const token = await memberToken(strategy);
      const service = createTokenService(keyed[strategy], strategy, false);

      try {
        expect(warn).not.toHaveBeenCalled();
        expect(await service.verifyToken(token, { audience: "access" })).toEqual(
          expect.objectContaining({ role: "member" }),
        );
      } finally {
        service.close();
      }
    },
  );

  it("paseto_public verifies with the public key alone", async () => {
    const token = await memberToken("paseto_public");
    const verifyOnly = EnvZod.parse({
      ADMIN_SECRET: adminSecret,
      ANONYMOUS_ROLE: anonymousRole,
      PASETO_PUBLIC_KEY: publicKey,
    });
    const service = createTokenService(verifyOnly, "paseto_public", false);

    try {
      expect(warn).not.toHaveBeenCalled();
      expect(await service.verifyToken(token, { audience: "access" })).toEqual(
        expect.objectContaining({ role: "member" }),
      );
    } finally {
      service.close();
    }
  });
});

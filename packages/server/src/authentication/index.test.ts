import { describe, expect, it } from "bun:test";
import { generateKeys } from "paseto-ts/v4";

import { createTokenService } from ".";
import { EnvZod } from "../types/env";

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
